import fs from "node:fs/promises";

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

async function api(host, pathname, init) {
  const res = await fetch(`${host}${pathname}`, { ...init, signal: AbortSignal.timeout(10000) });
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
export async function rqEnsureTorrent({ infoHash, nameHint }) {
  const c = await loadCfg();
  if (!c?.host) return null;
  const host = c.host.replace(/\/$/, "");

  // Already added? (rqbit lists torrents with an id + info_hash)
  let list = await api(host, "/torrents");
  let found = (list?.torrents || []).find(
    (t) => (t.info_hash || t.infoHash || "").toLowerCase() === infoHash.toLowerCase(),
  );

  if (!found) {
    // rqbit 9 expects the magnet in a JSON body (query-string form returns
    // HTTP 400 there). Body payload first; query string kept as a fallback
    // for older rqbit versions.
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    let added = false;
    try {
      await api(host, "/torrents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: magnet, options: { overwrite: true, only_downloads: false } }),
      });
      added = true;
    } catch {
      // fallback: v8-style query string
      const q = new URLSearchParams({
        url: magnet,
        overwrite: "true",
        only_downloads: "false",
        output_format: "json",
      });
      await api(host, `/torrents?${q}`, { method: "POST" });
      added = true;
    }
    if (!added) throw new Error("rqbit: could not add magnet");
    // wait for metadata briefly
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
