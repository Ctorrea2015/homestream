import fs from "node:fs/promises";
import path from "node:path";

export const IPTV_FILE = path.join(process.cwd(), ".data", "iptv.json");

export async function readIptv() {
  try {
    return JSON.parse(await fs.readFile(IPTV_FILE, "utf8"));
  } catch {
    return { sources: [], channels: [] };
  }
}

export async function writeIptv(data) {
  await fs.mkdir(path.dirname(IPTV_FILE), { recursive: true });
  await fs.writeFile(IPTV_FILE, JSON.stringify(data, null, 2), "utf8");
}

function attr(text, name) {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(text);
  return m ? m[1] : "";
}

/**
 * Parse an M3U / M3U8 playlist into channel entries.
 * Handles the standard #EXTINF fields: title, tvg-logo, group-title,
 * plus #EXTURN lines and plain-URL playlists.
 */
export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.toUpperCase().startsWith("#EXTM3U")) continue;

    if (line.toUpperCase().startsWith("#EXTINF")) {
      // #EXTINF:<duration> <attrs>,<title>
      const m = /^#EXTINF:\s*[^,]*,\s*(.+)$/.exec(line);
      pending = {
        name: (m && m[1].trim()) || "Unknown channel",
        logo: attr(line, "tvg-logo"),
        group: attr(line, "group-title") || "",
        tvgId: attr(line, "tvg-id") || "",
        url: "",
      };
      continue;
    }

    if (line.startsWith("#")) continue; // #EXTVLCOPT, #KODIPROP etc. — ignorable

    // First non-comment line after an EXTINF is the stream URL
    if (pending) {
      pending.url = line;
      channels.push(pending);
      pending = null;
    }
  }
  return channels.filter((c) => c.url);
}

/** Fetch text from http(s), or read a local file path. */
export async function loadPlaylist(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { headers: { "User-Agent": "HomeStream/1.0 VLC/3.0" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Playlist download failed: HTTP ${res.status}`);
    return await res.text();
  }
  return await fs.readFile(source, "utf8");
}

/**
 * Merge a parsed channel list into the library as one named source.
 * Used by both plain M3U import and Xtream provider login.
 */
export function mergeSourceData(data, sourceInfo, parsed) {
  const sources = [
    ...data.sources.filter((s) => s.key !== sourceInfo.key),
    { ...sourceInfo, added: new Date().toISOString(), count: parsed.length },
  ];

  const channels = [...data.channels.filter((c) => c.source !== sourceInfo.key)];
  for (const c of parsed) {
    c.source = sourceInfo.key;
    channels.push(c);
  }

  // Drop exact-duplicate stream URLs (first wins)
  const seen = new Set();
  const unique = [];
  for (const c of channels) {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      unique.push(c);
    }
  }

  // Drop failure records for channels that no longer exist.
  const alive = new Set(unique.map((c) => c.url));
  const meta = {};
  for (const [url, rec] of Object.entries(data.meta || {})) {
    if (alive.has(url)) meta[url] = rec;
  }

  return { sources, channels: unique, meta };
}
