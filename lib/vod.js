import fs from "node:fs/promises";
import path from "node:path";
import { readIptv } from "./iptv.js";

export const VOD_FILE = path.join(process.cwd(), ".data", "vod.json");

export async function readVod() {
  try {
    return JSON.parse(await fs.readFile(VOD_FILE, "utf8"));
  } catch {
    return { refreshed: 0, movies: [], series: [] };
  }
}

export async function writeVod(data) {
  await fs.mkdir(path.dirname(VOD_FILE), { recursive: true });
  await fs.writeFile(VOD_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function xtreamApi(host, username, password, action, extra = "") {
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  const url = `${host}/player_api.php?username=${user}&password=${pass}&action=${action}${extra}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "HomeStream/1.0 VLC/3.0" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${action}`);
  const payload = await res.json();
  if (!Array.isArray(payload)) {
    // Some providers wrap lists in {movies: []} / {series: []} / {categories: []}
    const firstArray = Object.values(payload || {}).find(Array.isArray);
    return firstArray || [];
  }
  return payload;
}

/** Movie file url on the provider, e.g. /movie/user/pass/12345.mp4 */
export function movieUrl(host, username, password, streamId, container) {
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  return `${host}/movie/${user}/${pass}/${streamId}.${container || "mp4"}`;
}

/** Episode file url, e.g. /series/user/pass/9821.mkv */
export function episodeUrl(host, username, password, episodeId, container) {
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  return `${host}/series/${user}/${pass}/${episodeId}.${container || "mkv"}`;
}

/**
 * Pull movies + series for every connected Xtream source.
 * Each entry keeps its key so playback knows which provider to hit.
 */
export async function refreshVodFromSources() {
  const iptv = await readIptv();
  const xtreamSources = iptv.sources.filter((s) => s.kind === "xtream");

  const movies = [];
  const series = [];

  for (const s of xtreamSources) {
    try {
      const base = { prov: s.key, host: s.host, username: s.username, password: s.password };
      const vodCats = await xtreamApi(s.host, s.username, s.password, "get_vod_categories");
      const vodCatName = new Map(vodCats.map((c) => [String(c.category_id), c.category_name]));
      const vodStreams = await xtreamApi(s.host, s.username, s.password, "get_vod_streams");

      for (const m of vodStreams) {
        movies.push({
          kind: "movie",
          prov: base.prov,
          id: String(m.stream_id),
          title: m.name || "Untitled movie",
          poster: m.stream_icon || m.cover || "",
          rating: m.rating || "",
          year: (m.title || "").match(/\b(19|20)\d{2}\b/)?.[0] || "",
          container: m.container_extension || m.ext || "mp4",
          category: vodCatName.get(String(m.category_id)) || "",
        });
      }

      const serCats = await xtreamApi(s.host, s.username, s.password, "get_series_categories");
      const serCatName = new Map(serCats.map((c) => [String(c.category_id), c.category_name]));
      const serStreams = await xtreamApi(s.host, s.username, s.password, "get_series");

      for (const sr of serStreams) {
        series.push({
          kind: "series",
          prov: base.prov,
          id: String(sr.series_id),
          title: sr.name || "Untitled series",
          poster: sr.cover || sr.stream_icon || "",
          rating: sr.rating || "",
          year: (sr.plot || sr.name || "").match(/\b(19|20)\d{2}\b/)?.[0] || "",
          genre: sr.genre || "",
          category: serCatName.get(String(sr.category_id)) || "",
        });
      }
    } catch {
      // One provider failing shouldn't block the others.
    }
  }

  const out = { refreshed: Date.now(), movies, series };
  await writeVod(out);
  return out;
}

/** Series details: seasons + episode list with playable urls. */
export async function fetchSeriesInfo(prov, seriesId) {
  const iptv = await readIptv();
  const s = iptv.sources.find((x) => x.key === prov);
  if (!s) throw new Error("This provider is no longer connected");

  const info = await xtreamApi(s.host, s.username, s.password, "get_series_info", `&series_id=${encodeURIComponent(seriesId)}`);
  const seasons = [];
  const raw = info?.episodes || {};

  const seasonIds = Object.keys(raw).sort((a, b) => Number(a) - Number(b));
  for (const sid of seasonIds) {
    const eps = (raw[sid] || []).map((e) => ({
      id: String(e.id),
      title: e.title || `Episode ${e.episode_num}`,
      episodeNum: Number(e.episode_num) || 0,
      container: e.container_extension || "mkv",
      duration: e.duration || "",
      plot: e.info?.plot || "",
    }));
    seasons.push({ season: Number(sid), episodes: eps });
  }

  return {
    prov,
    host: s.host,
    username: s.username,
    password: s.password,
    overview: info?.info?.plot || "",
    poster: info?.info?.cover_big || "",
    seasons,
  };
}
