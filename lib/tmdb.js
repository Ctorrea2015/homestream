import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, cleanTitle } from "./videos.js";

/**
 * TMDB (themoviedb.org) metadata: posters, years, descriptions.
 * Free API key — the user pastes theirs into Settings (stored in
 * .data/settings.json). Results are cached forever in .data/tmdb-cache.json
 * so a movie is only ever looked up once.
 */

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const CACHE_FILE = path.join(DATA_DIR, "tmdb-cache.json");
const IMG_BASE = "https://image.tmdb.org/t/p/w500";

export async function getTmdbKey() {
  try {
    const s = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"));
    return s.tmdbKey || process.env.TMDB_KEY || "";
  } catch {
    return process.env.TMDB_KEY || "";
  }
}

export async function setTmdbKey(key) {
  let s = {};
  try { s = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")); } catch {}
  s.tmdbKey = key.trim();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf8");
}

async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function tmdbGet(key, urlPath, params) {
  const url = new URL(`https://api.themoviedb.org/3${urlPath}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("include_adult", "true");
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function metaFromHit(hit) {
  if (!hit) return null;
  const poster = hit.poster_path ? IMG_BASE + hit.poster_path : "";
  const overview = hit.overview || "";
  const date = hit.release_date || hit.first_air_date || "";
  const year = date ? date.slice(0, 4) : "";
  if (!poster && !overview && !year) return null;
  return { poster, year, overview };
}

/** "The Matrix.1999.1080p" -> { title: "The Matrix", year: 1999 } */
function parseMovieName(name) {
  const yearM = /\b(19|20)\d{2}\b/.exec(name);
  const year = yearM ? yearM[0] : "";
  const title = cleanTitle(name.replace(/\b(19|20)\d{2}\b/, ""));
  return { title, year };
}

async function searchMovie(key, title, year) {
  const data = await tmdbGet(key, "/search/movie", { query: title, year });
  return metaFromHit(data?.results?.[0]);
}

async function searchShow(key, show) {
  const data = await tmdbGet(key, "/search/tv", { query: show });
  return metaFromHit(data?.results?.[0]);
}

/**
 * Fill in v.meta { poster, year,Overview } for library entries that don't
 * have it yet. Budget-limited (TMDB rate-friendliness) per call; repeated
 * scans finish the job. Episodes share one lookup per show.
 */
export async function enrichVideos(videos, budget = 30) {
  const key = await getTmdbKey();
  if (!key) return { enriched: 0, needsKey: true, total: videos.filter((v) => !v.meta).length };

  const cache = await loadJson(CACHE_FILE, {});
  let touched = false;
  let enriched = 0;

  for (const v of videos) {
    if (v.meta || budget <= 0) continue;
    const isTv = v.kind === "episode";
    const title = cleanTitle(isTv ? v.show : parseMovieName(v.name).title);
    if (!title) continue;

    const cacheKey = (isTv ? "tv:" : "mv:") + title.toLowerCase();
    let hit = cache[cacheKey];
    if (hit === undefined) {
      hit = isTv ? await searchShow(key, title) : await searchMovie(key, title, parseMovieName(v.name).year);
      cache[cacheKey] = hit;
      touched = true;
      budget -= 1;
      await new Promise((r) => setTimeout(r, 300)); // be polite to TMDB
    }
    v.meta = hit;
    if (hit) enriched += 1;
  }

  if (touched) await saveJson(CACHE_FILE, cache);
  return { enriched, needsKey: false, total: videos.filter((x) => !x.meta).length };
}
