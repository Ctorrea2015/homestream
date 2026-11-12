import fs from "node:fs/promises";
import { FALLBACK_TRACKERS } from "./qbittorrent";

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

import path from "node:path";

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
    // POST response timing.
    for (let i = 0; i < 30; i++) {
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
  let pick = -1, bestLen = -1;
  files.forEach((f, i) => {
    const name = f.name || f.file_name || "";
    const len = Number(f.length ?? f.file_length ?? 0);
    if (isVideo(name) && len > bestLen) { pick = i; bestLen = len; }
  });
  if (pick < 0) throw new Error("no playable video file inside this torrent");

  // Prefer the biggest video file unless a name hint matches one exactly.
  if (nameHint) {
    files.forEach((f, i) => {
      const name = f.name || f.file_name || "";
      if (isVideo(name) && name.toLowerCase().includes(String(nameHint).toLowerCase().slice(0, 20))) {
        pick = i;
      }
    });
  }

  const name = files[pick]?.name || files[pick]?.file_name || "video";
  return {
    streamUrl: `${host}/torrents/${id}/stream/${pick}`,
    name,
    size: Number(files[pick]?.length ?? files[pick]?.file_length ?? 0),
  };
}
