import fs from "node:fs/promises";
import path from "node:path";
import { FALLBACK_TRACKERS } from "./trackers";

/**
 * librqbit engine (https://github.com/ikatson/rqbit) — a lean Rust torrent
 * daemon with an HTTP API and a native streaming endpoint that supports
 * HTTP Range requests. Sits between qBittorrent (primary) and webtorrent
 * (fallback): qB → rqbit → webtorrent.
 *
 * Config (optional): .data/rqbit.json  { "host": "http://127.0.0.1:3030" }
 * No auth by default — rqbit binds to localhost.
 */

let cfg = null;
async function loadCfg() {
  if (cfg !== null) return cfg;
  try {
    cfg = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "rqbit.json"), "utf8"));
  } catch {
    // No config file: default to the standard localhost rqbit API — this is
    // what our systemd service installs, so it just works out of the box.
    cfg = { host: "http://127.0.0.1:3030" };
  }
  return cfg;
}

async function api(host, pathname, init, timeoutMs = 10000) {
  const res = await fetch(`${host}${pathname}`, {
    ...init,
    // Long timeout for magnet ingestion (metadata resolution can block the
    // POST response); aborting early would kill a working registration.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Status first — log truncation cuts the tail, never lose the code.
    throw new Error(`rqbit HTTP ${res.status} ${pathname.split("?")[0]}: ${body.slice(0, 80)}`);
  }
  return res.json();
}

const isVideo = (n) => /\.(mp4|mkv|avi|mov|m4v|webm|ts|mpg|wmv|flv)$/i.test(n || "");

export async function rqAvailable() {
  const c = await loadCfg();
  return !!c?.host;
}

/**
 * Ensure the torrent is added and settled, then return the streaming URL
 * for the best video file: { streamUrl, name, size }.
 */
export async function rqEnsureTorrent({ infoHash, nameHint, trackers }) {
  const c = await loadCfg();
  if (!c?.host) return null;
  const host = c.host.replace(/\/$/, "");

  // Already added? (rqbit lists torrents with an id + info_hash)
  let list = await api(host, "/torrents");
  let found = (list?.torrents || []).find(
    (t) => (t.info_hash || t.infoHash || "").toLowerCase() === infoHash.toLowerCase(),
  );

  if (!found) {
    // Official v9 contract (github.com/ikatson/rqbit README): POST the raw
    // magnet URI as the request body; options ride as query params.
    // ("Only_downloads"/JSON shapes were the 400's cause.) Tracker
    // injection: every &tr= rides in the magnet URI itself.
    const trs = [...(trackers || []), ...FALLBACK_TRACKERS].map((t) =>
      `&tr=${encodeURIComponent(t)}`);
    const magnet = `magnet:?xt=urn:btih:${infoHash}${trs.join("")}`;
    const q = new URLSearchParams({ overwrite: "true" });
    await api(host, `/torrents?${q}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: magnet,
    }, 30000);
    // The task registers instantly but metadata resolution can take longer;
    // poll /torrents for the info_hash to appear rather than trusting the
    // POST response timing. 60s (not 30): season-pack swarms are often slow
    // to hand over metadata, and an early give-up silently routes shows to
    // the qB fallback instead of rqbit, the primary engine.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      list = await api(host, "/torrents");
      found = (list?.torrents || []).find(
        (t) => (t.info_hash || t.infoHash || "").toLowerCase() === infoHash.toLowerCase(),
      );
      if (found) break;
    }
  }
  if (!found) throw new Error("rqbit could not fetch torrent metadata in time");
  const id = found.id;

  // Files: GET /torrents/{id} → details.files[] (name/length varies by version)
  const detail = await api(host, `/torrents/${id}`);
  const files = detail?.files || detail?.details?.files || [];

  /**
   * Same scoring as lib/torrent.js pickVideoFile: in a season pack every
   * episode shares the show name, so only the exact SxxEyy in the hint may
   * decide. (The old check — hint.slice(0, 20) — matched the show name on
   * every sibling and effectively picked a random episode; movies played
   * because single-file torrents always fall through to "biggest".)
   */
  function pickRqFile(list, hint) {
    const videos = [];
    list.forEach((f, i) => {
      const name = f.name || f.file_name || "";
      if (isVideo(name)) videos.push({ i, name, len: Number(f.length ?? f.file_length ?? 0) });
    });
    if (!videos.length) return -1;

    const h = String(hint || "");
    const words = h.toLowerCase().replace(/[^\w]+/g, " ").split(/\s+/).filter((w) => w.length >= 3);
    const hasVideoWord = (s) => /(2160p|1080p|720p|web[\s.-]?dl|blu[\s.-]?ray|remux|x264|x265|hevc|cam|ts)/i.test(s);
    const epMatch = /s(\d{1,2})e(\d{1,3})/i.exec(h);
    const epFileRe = epMatch
      ? new RegExp(`s0*${Number(epMatch[1])}e0*${Number(epMatch[2])}(?:[^\\d]|$)`, "i")
      : null;

    const scored = videos.map((x) => {
      const fn = x.name.toLowerCase();
      let score = words.reduce((acc, w) => acc + (fn.includes(w) ? 1 : 0), 0);
      if (words.length && score > 0 && hasVideoWord(fn)) score += 1;
      if (epFileRe && epFileRe.test(x.name)) score += 100; // the exact episode wins outright
      if (epFileRe && !epFileRe.test(x.name)) score = Math.min(score, 3); // demote siblings
      return { ...x, score };
    });

    const best = Math.max(...scored.map((s) => s.score));
    if (best > 0) {
      const top = scored.filter((s) => s.score === best).sort((a, b) => b.len - a.len);
      return top[0].i;
    }
    // no hint / no overlap: prefer real titles over samples/extras
    const sizeable = scored.filter((s) => s.len > 300 * 1024 * 1024);
    if (sizeable.length) return sizeable.sort((a, b) => b.len - a.len)[0].i;
    return scored.sort((a, b) => b.len - a.len)[0].i;
  }

  const pick = pickRqFile(files, nameHint);
  if (pick < 0) throw new Error("no playable video file inside this torrent");

  const name = files[pick]?.name || files[pick]?.file_name || "video";
  return {
    streamUrl: `${host}/torrents/${id}/stream/${pick}`,
    name,
    size: Number(files[pick]?.length ?? files[pick]?.file_length ?? 0),
  };
}
