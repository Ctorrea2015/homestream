import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// All app data lives in a .data folder next to the app — easy to back up,
// easy to reset (just delete the folder).
export const DATA_DIR = path.join(process.cwd(), ".data");
export const LIBRARY_FILE = path.join(DATA_DIR, "library.json");

export async function readLibrary() {
  try {
    const raw = await fs.readFile(LIBRARY_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { folders: [], videos: [] };
  }
}

export async function writeLibrary(lib) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(LIBRARY_FILE, JSON.stringify(lib, null, 2), "utf8");
}

export function idForPath(absPath) {
  return crypto.createHash("sha1").update(path.normalize(absPath).toLowerCase()).digest("hex").slice(0, 16);
}

const VIDEO_EXTS = new Set([
  ".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".wmv",
  ".flv", ".mpg", ".mpeg", ".ts", ".3gp", ".ogv",
]);

// "Some.Movie.2023.1080p.mkv" -> "Some Movie 2023 1080p"
export function prettyName(fileName) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[._]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Strip release noise so "The.Matrix.1999.1080p.BluRay.x264" -> "The Matrix"
export function cleanTitle(s) {
  return (s || "")
    .replace(/[._]+/g, " ")
    .replace(/\b(2160p|1080p|1080i|720p|480p|hdtv|web[\s._-]?dl|web[\s._-]?rip|hdrip|brrip|bdrip|blu[\s._-]?ray|dvd[\s._-]?(rip|scr)|dvd|x264|x265|\d?10bit|h[\s._]?264|h[\s._]?265|hevc|aac|dts(\s?hd)?|ac3|ddp?5\.1|atmos|amzn|nfadult|nf|dsnp|multi|proper|repack|extended|unrated|remastered|remux|yify|rarbg|xvid|truefrench|french|vostfr)\b/gi, " ")
    .replace(/\((19|20)\d{2}\)/g, " ")
    .replace(/\((?:.*?1920.*?1080|.*?3840.*?2160)\)/gi, " ")
    .replace(/[-–_]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Detect TV episodes in file names / folder names.
 * Handles: "Breaking.Bad.S02E05.mkv", "1x03 Title.mp4",
 *          "Breaking Bad/S01/S01E04 - Woke Up.mp4", "Show/Season 2/file.mkv"
 * Returns { kind, show, season, episode } — kind is "episode" or "movie".
 */
export function parseEpisodeInfo(fileName, relDir = "") {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const m = /(?:\bs(\d{1,2})[\s._-]?e(\d{1,3})\b)|(?:\b(\d{1,2})x(\d{1,3})\b)/i.exec(stem);

  if (m) {
    const show = cleanTitle(stem.slice(0, m.index)) || cleanTitle(relDir.split(/[\\/]/)[0]) || prettyName(fileName);
    return {
      kind: "episode",
      show,
      season: parseInt(m[1] || m[3], 10),
      episode: parseInt(m[2] || m[4], 10),
    };
  }

  // Folder hint: "Show Name\Season 1\file.mkv" or "Show Name\S01\file.mkv"
  const parts = relDir.split(/[\\/]/).filter(Boolean);
  const dirM = /\b(?:s(\d{1,2})|season[\s._-]?(\d{1,2}))\b/i.exec(relDir);
  if (dirM && parts.length) {
    return {
      kind: "episode",
      show: cleanTitle(parts[0]),
      season: parseInt(dirM[1] || dirM[2], 10),
      episode: null, // unknown — UI sorts by file order
    };
  }

  return { kind: "movie", show: "", season: null, episode: null };
}

// "Some.Movie.2023.1080p.mkv" -> { title: "Some Movie 2023 1080p", year: "2023" }
export function parseMovieName(name) {
  const yearM = /\b(19|20)\d{2}\b/.exec(name);
  const year = yearM ? yearM[0] : "";
  const title = cleanTitle(name.replace(/\b(19|20)\d{2}\b/, ""));
  return { title, year };
}

const SKIP_DIRS = new Set(["node_modules", ".data", ".next", ".git", "$RECYCLE.BIN", "System Volume Information"]);

/**
 * Scan a folder (recursively, up to a sane depth) and return video entries
 * for the library. Schema matches what the library UI expects:
 * { id, root, path, name, ext, kind, show, season, episode, size, mtime }
 */
export async function scanFolder(root, maxResults = 5000) {
  const out = [];
  const base = path.resolve(root);

  async function walk(dir, rel, depth) {
    if (out.length >= maxResults || depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip quietly
    }
    for (const ent of entries) {
      if (out.length >= maxResults) return;
      const name = ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
        await walk(path.join(dir, name), path.join(rel, name), depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;

      const abs = path.join(dir, name);
      const info = parseEpisodeInfo(name, rel);
      let stat = null;
      try { stat = await fs.stat(abs); } catch {}
      out.push({
        id: idForPath(abs),
        root: base,
        path: abs,
        rel: path.join(rel, name),
        name: prettyName(name),
        ext,
        kind: info.kind,
        show: info.show || "",
        season: info.season,
        episode: info.episode,
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtimeMs : 0,
      });
    }
  }

  try {
    const stat = await fs.stat(base);
    if (!stat.isDirectory()) return null; // not a folder → caller reports error
  } catch {
    return null;
  }
  await walk(base, "", 0);
  return out;
}