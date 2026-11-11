import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";

/**
 * qBittorrent (headless) as the torrent engine.
 *
 * The app talks to qBittorrent's WebUI API on localhost: qB does the actual
 * swarm work with sequential downloading (made for streaming), and we serve
 * the file bytes off its disk with Range requests. If no qBittorrent config
 * exists, everything here returns null and the webtorrent engine handles it
 * — both engines can coexist on the same box.
 *
 * Config: .data/qbittorrent.json
 *   { "host": "http://127.0.0.1:8080", "user": "admin", "pass": "..." }
 */

const CONFIG_PATH = path.join(process.cwd(), ".data", "qbittorrent.json");
const FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];

let cookie = null;
let cookieAt = 0;

async function cfg() {
  try {
    const c = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    if (c && c.host) return c;
    return null;
  } catch {
    return null;
  }
}

async function api(c, method, apiPath, body, isForm) {
  const headers = { Cookie: cookie || "" };
  let payload;
  if (body && isForm) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body).toString();
  } else if (body) {
    payload = body;
  }
  const res = await fetch(`${c.host}${apiPath}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 403) { // session expired
    cookie = null;
    throw new Error("qbittorrent auth expired");
  }
  return res;
}

async function login(c) {
  if (cookie && Date.now() - cookieAt < 10 * 60 * 1000) return;
  const res = await fetch(`${c.host}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: c.user || "admin", password: c.pass || "" }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  const sc = res.headers.get("set-cookie") || "";
  if (!res.ok || !/Ok/.test(text) || !sc.includes("SID=")) throw new Error("qbittorrent login failed");
  cookie = /SID=[^;]+/.exec(sc)?.[0] || "";
  cookieAt = Date.now();
}

async function withSession(c, method, apiPath, body, isForm) {
  try {
    return await api(c, method, apiPath, body, isForm);
  } catch (e) {
    if (/auth expired/.test(String(e))) {
      cookie = null;
      await login(c);
      return api(c, method, apiPath, body, isForm);
    }
    throw e;
  }
}

/** Pick the video file from qB's file list — same rules as the webtorrent picker. */
export function pickQbVideoFile(files, nameHint) {
  const vids = files.filter((f) => /\.(mp4|mkv|avi|webm|mov|m4v|ts|mpg|wmv|flv)$/i.test(f.name));
  if (!vids.length) return null;
  const want = (nameHint || "").toUpperCase();
  const m = want.match(/S(\d{1,2})E(\d{1,3})/);
  if (m) {
    const scored = vids.map((f) => {
      const fm = f.name.toUpperCase().match(new RegExp(`S0*${m[1]}E0*${m[2]}\\D`));
      return { f, s: fm ? 2 : (f.name.toUpperCase().includes(`S${m[1]}`) ? 1 : 0) };
    }).sort((a, b) => b.s - a.s);
    if (scored[0].s > 0) return scored[0].f;
  }
  return vids.sort((a, b) => b.size - a.size)[0];
}

const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
  ".ts": "video/mp2t", ".flv": "video/x-flv", ".mpg": "video/mpeg", ".wmv": "video/x-ms-wmv",
};

/**
 * Ensure the torrent is added to qBittorrent and a video file exists.
 * Returns { filePath, size, name } — the on-disk file to range-read.
 */
export async function qbEnsureTorrent({ infoHash, nameHint, waitMs = 120000 }) {
  const c = await cfg();
  if (!c) return null;

  await login(c);

  // Already added?
  let info = null;
  const existing = await withSession(c, "GET", `/api/v2/torrents/info?hash=${infoHash}`);
  if (existing.ok) {
    const arr = await existing.json().catch(() => []);
    info = arr.find((t) => t.hash?.toLowerCase() === infoHash) || null;
  }
  if (!info) {
    const magnet = `magnet:?xt=urn:btih:${infoHash}` +
      FALLBACK_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
    const add = await withSession(c, "POST", "/api/v2/torrents/add", {
      urls: magnet,
      sequentialDownload: "true",
      firstLastPiecePrio: "true",
    }, true);
    if (!add.ok) throw new Error("qbittorrent rejected the magnet");
  }

  // Wait for metadata + a video file, then for the first bytes to land.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const filesRes = await withSession(c, "GET", `/api/v2/torrents/files?hash=${infoHash}`);
    if (filesRes.ok) {
      const files = await filesRes.json().catch(() => []);
      const pick = pickQbVideoFile(files, nameHint);
      if (pick) {
        // content_path/save_path from torrents/info
        const infoRes = await withSession(c, "GET", `/api/v2/torrents/info?hash=${infoHash}`);
        const arr = infoRes.ok ? await infoRes.json().catch(() => []) : [];
        const t = arr.find((x) => x.hash?.toLowerCase() === infoHash);
        if (t) {
          const base = t.content_path || t.save_path || "";
          const full = files.length === 1 ? base : path.join(t.save_path || "", pick.name);
          try {
            const st = await fs.stat(full);
            if (st.size > 0 || t.progress > 0) return { filePath: full, size: pick.size, name: pick.name, qbHash: infoHash };
          } catch {}
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("qBittorrent: no video data arrived in time");
}

/**
 * Serve a byte range of a qB-managed file. Returns a Node stream or null.
 */
export function qbReadRange(filePath, start, end) {
  return createReadStream(filePath, { start, end });
}

export async function qbAvailable() {
  return !!(await cfg());
}
