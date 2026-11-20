/**
 * rqbit-compatible engine service.
 *
 * Implements the EXACT HTTP API HomeStream's lib/rqbit.js calls, so you can
 * point HomeStream at it with .data/rqbit.json:
 *   { "host": "http://127.0.0.1:3031" }
 *
 * Backends:
 *   "mock" — serves a local file with simulated stats (zero setup, for dev)
 *   "qb"   — proxies to qBittorrent's WebUI API (real downloads today; swap
 *            in your own peer/piece logic later without touching HomeStream)
 *
 * Run: node custom-engine/rqbit-compatible.mjs
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CFG_PATH = new URL("./rqbit-compat-config.json", import.meta.url);
const CFG = { port: 3031, backend: "mock", qbUrl: "http://127.0.0.1:8080",
  qbUser: "admin", qbPass: "adminadmin",
  mock: { infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", file: "./custom-engine/sample.mkv" },
  ...JSON.parse(await fs.readFile(CFG_PATH, "utf8").catch(() => "{}")) };
const PORT = Number(CFG.port || 3031);

/* ---------------------------- helpers ---------------------------------- */

const j = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Extract the infoHash from .torrent bytes (sha1 of the bencoded info dict). */
function infoHashFromTorrent(buf) {
  const marker = Buffer.from("4:info");
  const at = buf.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  function scan() {
    const c = buf[i];
    if (c === 0x64) { i++; while (buf[i] !== 0x65 && i < buf.length) scan(); i++; return; }
    if (c === 0x6c) { i++; while (buf[i] !== 0x65 && i < buf.length) scan(); i++; return; }
    if (c >= 0x30 && c <= 0x39) {
      const s = i; while (buf[i] !== 0x3a && i < buf.length) i++;
      const n = parseInt(buf.toString("ascii", s, i), 10); i += 1 + n; return;
    }
    while (buf[i] !== 0x65 && i < buf.length) i++; i++; // integer
  }
  scan();
  return crypto.createHash("sha1").update(buf.subarray(at + marker.length, i)).digest("hex");
}

/* --------------------------- mock backend ------------------------------- */

const mockState = { added: false };
const MOCK_HASH = String(CFG.mock.infoHash || "").toLowerCase();

const mock = {
  async list() {
    return mockState.added ? [{ id: 0, info_hash: MOCK_HASH, name: "Mock Show S01E01", total_pieces: 1 }] : [];
  },
  async add(hash) {
    if (hash !== MOCK_HASH) throw new Error(`mock backend only knows ${MOCK_HASH}`);
    mockState.added = true;
    return { id: 0, details: { id: 0, info_hash: MOCK_HASH } };
  },
  async detail(id) {
    const f = path.resolve(CFG.mock.file);
    return { id: 0, output_folder: path.dirname(f), files: [{ name: path.basename(f), length: (await fs.stat(f).catch(() => ({ size: 0 }))).size }] };
  },
  async stats() {
    return {
      snapshot: { fetched_bytes: 1024, downloaded_and_checked_bytes: 1024,
        peer_stats: { live: 3, live_seeders: 2, seen: 10 } },
      download_speed: { human_readable: "1.00 MiB/s" },
      time_remaining: { human_readable: "0s" },
    };
  },
  async onlyFiles() { return {}; },
  async delete() { mockState.added = false; return {}; },
  async streamPath(idx) { return path.resolve(CFG.mock.file); },
};

/* --------------------------- qB backend --------------------------------- */

let sid = null;
async function qb(ep, init = {}) {
  if (!sid) {
    const form = new URLSearchParams({ username: CFG.qbUser, password: CFG.qbPass });
    const r = await fetch(`${CFG.qbUrl}/api/v2/auth/login`, { method: "POST", body: form, signal: AbortSignal.timeout(8000) });
    const cookie = r.headers.get("set-cookie") || "";
    sid = /SID=([^;]+)/.exec(cookie)?.[1] || "";
    if (!sid) throw new Error(`qB login failed: HTTP ${r.status}`);
  }
  const r = await fetch(`${CFG.qbUrl}/api/v2${ep}`, { ...init, headers: { Cookie: `SID=${sid}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`qB ${ep} -> HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  return /json/.test(ct) ? r.json() : r.text();
}

function qbFind(infoHash) {
  return qb("/torrents/info").then((all) => (Array.isArray(all) ? all : []).find((t) => String(t.hash || "").toLowerCase() === infoHash));
}

const qbb = {
  async list() {
    const all = await qb("/torrents/info");
    return (Array.isArray(all) ? all : []).map((t, id) => ({ id, info_hash: String(t.hash || "").toLowerCase(), name: t.name, total_pieces: 0, _hash: t.hash }));
  },
  async add(hash, { body, ctype, trackers }) {
    let addBody;
    if (/x-bittorrent/i.test(ctype)) {
      // qB accepts .torrent uploads as multipart/form-data
      const fd = "----hs" + Date.now();
      const parts = [
        `--${fd}\r\nContent-Disposition: form-data; name="torrents"; filename="torrent.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`,
        ...body, `\r\n--${fd}--\r\n`,
      ];
      addBody = Buffer.concat(parts.map((p) => Buffer.isBuffer(p) ? p : Buffer.from(p)));
      const r = await fetch(`${CFG.qbUrl}/api/v2/torrents/add`, { method: "POST", headers: { Cookie: `SID=${sid}`, "Content-Type": `multipart/form-data; boundary=${fd}` }, body: addBody, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`qB add -> HTTP ${r.status}`);
    } else {
      const form = new URLSearchParams({ urls: String(body || "") });
      if (trackers.length) form.set("tr", trackers.join("\n"));
      await qb("/torrents/add", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    }
    // wait for qB to register the hash
    for (let i = 0; i < 30; i++) {
      const t = await qbFind(hash).catch(() => null);
      if (t) return { id: (await qbb.list()).findIndex((x) => x.info_hash === hash), details: { id: 0, info_hash: hash } };
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("qB did not register the torrent in time");
  },
  async detail(id) {
    const t = (await qbb.list())[id];
    if (!t) throw new Error("no such torrent");
    const files = await qb(`/torrents/files?hash=${encodeURIComponent(t._hash)}`);
    return { output_folder: t.save_path || "", files: (files || []).map((f) => ({ name: f.name, length: f.size, index: f.index })) };
  },
  async stats(id) {
    const t = (await qbb.list())[id];
    if (!t) throw new Error("no such torrent");
    const raw = await qbFind(t.info_hash);
    return {
      snapshot: { fetched_bytes: raw.downloaded || 0, downloaded_and_checked_bytes: raw.downloaded || 0,
        peer_stats: { live: (raw.num_leechs || 0) + (raw.num_seeds || 0), live_seeders: raw.num_seeds || 0, seen: 0 } },
      download_speed: { human_readable: `${((raw.dlspeed || 0) / 1048576).toFixed(2)} MiB/s` },
      time_remaining: { human_readable: `${raw.eta || 0}s` },
    };
  },
  async onlyFiles(id, indexes) {
    const t = (await qbb.list())[id];
    const files = await qb(`/torrents/files?hash=${encodeURIComponent(t._hash)}`);
    const ids = (files || []).map((f) => f.index);
    const off = ids.filter((x) => !indexes.includes(x));
    const form = new URLSearchParams({ hash: t._hash, idList: indexes.join("|"), priority: "2" });
    await qb("/torrents/setFilePriority", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (off.length) await qb("/torrents/setFilePriority", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ hash: t._hash, idList: off.join("|"), priority: "0" }) });
    return {};
  },
  async delete(idOrHash) {
    const all = await qbb.list();
    const t = /^[a-f0-9]{40}$/i.test(idOrHash) ? all.find((x) => x.info_hash === idOrHash.toLowerCase()) : all[Number(idOrHash)];
    if (!t) return {};
    await qb("/torrents/delete", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ hashes: t._hash, deleteFiles: "true" }) });
    sid = null;
    return {};
  },
  async pause(id) {
    const t = (await qbb.list())[Number(id)];
    if (t) await qb("/torrents/pause", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ hashes: t._hash }) });
    return {};
  },
  async streamPath(id, idx) {
    const t = (await qbb.list())[Number(id)];
    const files = await this.detail(Number(id));
    const f = files.files[idx];
    if (!f) throw new Error("no such file index");
    return path.join(files.output_folder || "", f.name);
  },
};

const BE = CFG.backend === "qb" ? qbb : mock;

/* --------------------------- HTTP surface -------------------------------- */

function serveFile(res, file, range, method) {
  return fs.stat(file).then(async (st) => {
    let start = 0, end = st.size - 1;
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
    if (m && m[1]) start = parseInt(m[1], 10);
    if (m && m[2]) end = Math.min(parseInt(m[2], 10), st.size - 1);
    if (isNaN(start) || start > end) start = 0;
    const ext = path.extname(file).toLowerCase();
    const ct = { ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".avi": "video/x-msvideo", ".mov": "video/quickstart" }[ext] || "application/octet-stream";
    const headers = { "Content-Type": ct, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1) };
    if (m) headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(m ? 206 : 200, headers);
    if (method === "HEAD") return res.end();
    const fh = await fs.open(file, "r");
    fh.createReadStream({ start, end }).pipe(res);
  }).catch(() => j(res, 404, { error_kind: "no such torrent", human_readable: "file not found" }));
}
let reqMethod = "GET";

http.createServer(async (req, res) => {
  reqMethod = req.method;
  const u = new URL(req.url, "http://localhost");
  try {
    // canary: empty-body add must answer HTTP 400 instantly (watchdog contract)
    if (req.method === "POST" && u.pathname === "/torrents") {
      const buf = await body(req);
      const ctype = req.headers["content-type"] || "";
      if (!buf.length) return j(res, 400, { error_kind: "internal_error", human_readable: "error adding torrent: error decoding" });
      let hash = /x-bittorrent/i.test(ctype) ? infoHashFromTorrent(buf) : /([a-f0-9]{40})/i.exec(buf.toString())?.[1]?.toLowerCase();
      if (!hash) return j(res, 400, { error_kind: "internal_error", human_readable: "could not parse info hash" });
      const trQ = u.searchParams.getAll("tr");
      const out = await BE.add(hash, { body: /x-bittorrent/i.test(ctype) ? buf : buf.toString(), ctype, trackers: trQ });
      return j(res, 200, out);
    }
    if (req.method === "GET" && u.pathname === "/torrents") {
      return j(res, 200, { torrents: await BE.list() });
    }
    let m = /^\/torrents\/([^/]+)(?:\/(stats|delete|pause|update_only_files|stream))?(?:\/(\d+))?$/.exec(u.pathname);
    if (m) {
      const key = m[1], op = m[2], idx = m[3] ? Number(m[3]) : null;
      if (req.method === "GET" && !op) return j(res, 200, await BE.detail(key));
      if (req.method === "GET" && op === "stats") return j(res, 200, await BE.stats(key));
      if (req.method === "POST" && op === "delete") return j(res, 200, await BE.delete(key));
      if (req.method === "POST" && op === "pause") return j(res, 200, await BE.pause(key));
      if (req.method === "POST" && op === "update_only_files") {
        const b = JSON.parse((await body(req)).toString() || "{}");
        return j(res, 200, await BE.onlyFiles(key, b.only_files || []));
      }
      if (req.method === "GET" && op === "stream" && idx !== null) {
        const f = await BE.streamPath(key, idx);
        return serveFile(res, f, req.headers.range);
      }
    }
    if (u.pathname === "/") return j(res, 200, { ok: true, backend: CFG.backend, compat: "rqbit" });
    return j(res, 404, { error: "not found" });
  } catch (e) {
    return j(res, 500, { error_kind: "internal_error", human_readable: String(e?.message || e).slice(0, 120) });
  }
}).listen(PORT, () => console.log(`rqbit-compatible engine (${CFG.backend}) on http://127.0.0.1:${PORT}`));
