/**
 * RIPTIDE — HomeStream's custom streaming torrent engine.
 *
 * Speaks rqbit's exact HTTP API so HomeStream works unchanged
 * (.data/rqbit.json → { "host": "http://127.0.0.1:3031" }).
 *
 * Better than rqbit: real seeder gate (#2), 15s dead-swarm failover (#3),
 * stream-first file focus (#4), bounded state + rolling idle cleanup (#5).
 *
 * Backends:
 *   "mock" — serves a local file with simulated stats (zero setup, for dev)
 *   "qb"   — proxies to qBittorrent's WebUI API (real downloads today; swap
 *            in your own peer/piece logic later without touching HomeStream)
 *
 * Run: node custom-engine/riptide.mjs
 */
import http from "node:http";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CFG_PATH = new URL("./riptide-config.json", import.meta.url);
const DEFAULT = { port: 3031, backend: "mock", qbUrl: "http://127.0.0.1:8080",
  qbUser: "admin", qbPass: "adminadmin",
  // Better-than-rqbit knobs
  seederGate: true, minSeeders: 1, failoverMs: 15000, idleMs: 30 * 60 * 1000,
  mockSeeders: 6,
  scrapers: [
    { host: "tracker.opentrackr.org", port: 1337 },
    { host: "open.stealth.si", port: 80 },
    { host: "exodus.desync.com", port: 6969 },
    { host: "tracker.tiny-vps.com", port: 6969 },
  ],
  mock: { infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", file: "./custom-engine/sample.mkv" },
};
const CFG = {
  ...DEFAULT,
  // Reuse HomeStream's qB credentials (.data/qbittorrent.json) unless the
  // local config explicitly overrides them — no duplicate password entry.
  ...(() => {
    try {
      const q = JSON.parse(readFileSync(new URL("../.data/qbittorrent.json", import.meta.url), "utf8"));
      return q?.host ? { qbUrl: q.host, qbUser: q.user, qbPass: q.pass } : {};
    } catch { return {}; }
  })(),
  ...JSON.parse(await fs.readFile(CFG_PATH, "utf8").catch(() => "{}")),
};

const PORT = Number(CFG.port || 3031);

/* ------------------- real seeder verification (#2) ---------------------- */
/** UDP scrape a tracker for a 20-byte infoHash. Returns {seeders, leechers}
 *  or null on timeout. Uses the tracker's binary scrape protocol, not DHT. */
function scrapeTracker(host, port, hashBuf) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const finish = (val) => { clearTimeout(timer); try { sock.close(); } catch {} resolve(val); };
    sock.on("error", () => finish(null)); // ICMP port-unreachable must NOT crash the engine
    const timer = setTimeout(() => finish(null), 3000);
    sock.once("message", (msg) => {
      try {
        if (msg.length < 16) throw new Error("short");
        const action = msg.readUInt32BE(0);
        if (action !== 0) throw new Error("connect action");
        const cid = msg.subarray(8, 16);
        const req = Buffer.alloc(36);
        Buffer.from("0000041727101980", "hex").copy(req, 0); // protocol id
        req.writeUInt32BE(2, 8);                            // action=2 (scrape)
        cid.copy(req, 12);
        hashBuf.copy(req, 20);
        sock.send(req, port, host);
        sock.once("message", (reply) => {
          clearTimeout(timer);
          try {
            if (reply.readUInt32BE(0) !== 2 || reply.length < 20) throw new Error("bad scrape");
            resolve({ seeders: reply.readUInt32BE(16), leechers: reply.readUInt32BE(12) });
          } catch { resolve(null); }
          try { sock.close(); } catch {}
        });
      } catch { clearTimeout(timer); try { sock.close(); } catch {} resolve(null); }
    });
    const connect = Buffer.alloc(16);
    Buffer.from("0000041727101980", "hex").copy(connect, 0); // protocol id
    connect.writeUInt32BE(0, 8);                 // action 0 = connect
    connect.writeUInt32BE(1, 12);                // transaction id
    try { sock.send(connect, port, host); } catch { clearTimeout(timer); resolve(null); }
  });
}

/** Sum real seeders across trackers. Mock backend uses a configured number. */
async function verifySeeders(infoHash) {
  if (CFG.backend !== "qb") return Number(CFG.mockSeeders) || 0;
  const buf = Buffer.from(infoHash, "hex");
  if (buf.length !== 20) return 0;
  const results = await Promise.allSettled(CFG.scrapers.map((s) => scrapeTracker(s.host, s.port, buf)));
  const ok = results.filter((r) => r.status === "fulfilled" && r.value);
  if (!ok.length) return -1; // all scrapers failed → UNKNOWN, don't gate on it
  return ok.reduce((n, r) => n + r.value.seeders, 0);
}

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
    const text = await r.text().catch(() => "");
    // qB 4.x: 200 "Ok." + SID cookie | qB 5.x: 204 + SID cookie |
    // 5.x with "bypass auth for localhost" ON: 204 + NO cookie — but API
    // calls need no cookie at all. Treat all as valid (same as lib/qbittorrent.js).
    if (r.ok && (cookie.includes("SID=") || r.status === 204 || /Ok/.test(text))) {
      sid = /SID=[^;]+/.exec(cookie)?.[0]?.replace(/^SID=/, "") || "";
    } else {
      throw new Error(`qB login failed: HTTP ${r.status}`);
    }
  }
  const cookieHeader = sid ? { Cookie: `SID=${sid}` } : {};
  const r = await fetch(`${CFG.qbUrl}/api/v2${ep}`, { ...init, headers: { ...cookieHeader, ...(init.headers || {}) }, signal: AbortSignal.timeout(12000) });
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
      const r = await fetch(`${CFG.qbUrl}/api/v2/torrents/add`, { method: "POST", headers: { ...cookieHeader, "Content-Type": `multipart/form-data; boundary=${fd}` }, body: addBody, signal: AbortSignal.timeout(20000) });
      if (!r.ok && r.status !== 409) throw new Error(`qB add -> HTTP ${r.status}`);
    } else {
      // qB returns 409 "torrent already exists" if it's still in qB from a
      // previous play — that's SUCCESS for us, not a failure. Otherwise the
      // resolver falls back to rqbit (slow, no seeder gate/prefetch).
      const form = new URLSearchParams({ urls: String(body || "") });
      if (trackers.length) form.set("tr", trackers.join("\n"));
      const r = await fetch(`${CFG.qbUrl}/api/v2/torrents/add`, {
        method: "POST",
        headers: { ...cookieHeader, "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok && r.status !== 409) throw new Error(`qB add -> HTTP ${r.status}`);
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

/* ------------- bounded state / liveness / failover (#3 #4 #5) ----------- */
const liveness = new Map();   // id → { at, addAt, seeders, focus, alts, failed }
const MAX_STATE = 500;        // bounded memory: never grow past this
const touch = (key) => {
  const e = liveness.get(String(key));
  if (e) e.at = Date.now();
};

// Stream-first focus: HomeStream says which file it will play. Remember it so
// the engine can keep that file's pieces hot and drop the rest from state.
// (qB backend also sets real file priorities in onlyFiles.)
function setFocus(key, files) {
  const e = liveness.get(String(key));
  if (e) e.focus = files;
}

// Rolling cleanup (#5) + failover (#3): one timer, no per-request races.
setInterval(async () => {
  const now = Date.now();
  for (const [id, e] of liveness) {
    // Failover: no peers AND no bytes after 15s → drop and try the next source.
    if (!e.failed && e.alts?.length && now - e.addAt >= CFG.failoverMs) {
      try {
        const stat = await BE.stats(id);
        const snap = stat?.snapshot || {};
        const peers = Number(snap.peer_stats?.live ?? 0);
        const bytes = Number(snap.fetched_bytes ?? 0);
        if (peers === 0 && bytes === 0 && now - e.at >= CFG.failoverMs) {
          const next = e.alts.shift();
          console.log(`[engine] failover: torrent ${id} has 0 peers and 0 bytes after ${CFG.failoverMs / 1000}s — switching to ${next.slice(0, 10)}`);
          try { await BE.delete(id); } catch {}
          liveness.delete(String(id));
          const out = await BE.add(next, { body: `magnet:?xt=urn:btih:${next}`, ctype: "text/plain", trackers: [] });
          liveness.set(String(out.id), { at: now, addAt: now, seeders: await verifySeeders(next), alts: e.alts, focus: [] });
          continue;
        }
      } catch {}
    }
    // Rolling cleanup (#5): idle torrents are deleted.
    if (now - e.at > CFG.idleMs) {
      console.log(`[engine] idle cleanup: deleting torrent ${id} (${Math.round((now - e.at) / 60000)}min idle)`);
      try { await BE.delete(id); } catch {}
      liveness.delete(id);
    }
  }
  if (liveness.size > MAX_STATE) {
    for (const [id, e] of [...liveness].sort((a, b) => a[1].at - b[1].at).slice(0, liveness.size - MAX_STATE)) liveness.delete(id);
  }
}, 5000).unref?.();

// Startup sweep: after a restart, `liveness` is empty but qB may still hold
// old torrents from prior plays. Those cause HTTP 409 on add → Riptide fails →
// resolver falls to rqbit (slow). Delete qB torrents with 0 peers AND 0 bytes
// that aren't in liveness. Safe: a watched torrent has peers/bytes and would
// never be touched; any 0/0 entry is a dead leftover.
if (CFG.backend === "qb") {
  setTimeout(async () => {
    try {
      const all = await BE.list();
      let n = 0;
      for (const t of all) {
        if (liveness.has(String(t.id))) continue;
        try {
          const s = await BE.stats(t.id);
          const snap = s?.snapshot || {};
          if (Number(snap.peer_stats?.live ?? 0) === 0 && Number(snap.fetched_bytes ?? 0) === 0) {
            await BE.delete(t.id);
            n++;
          }
        } catch {}
      }
      if (n) console.log(`[engine] startup sweep: removed ${n} dead qB torrent(s)`);
    } catch {}
  }, 8000).unref?.();
}

http.createServer(async (req, res) => {
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
      // #2 HEALTH GATE: verify real seeders BEFORE adding. A dead swarm is
      // rejected immediately (HTTP 409), so HomeStream's resolver moves to
      // its next ranked candidate instead of stalling at 0 bytes.
      const seeders = await verifySeeders(hash);
      // -1 = scrapers unreachable (unknown, not dead) → fail OPEN rather than
      // rejecting a healthy swarm because UDP is blocked on this network.
      if (CFG.seederGate && seeders >= 0 && seeders < (CFG.minSeeders || 1)) {
        console.log(`[engine] seeder gate: REJECTED ${hash.slice(0, 10)} — ${seeders} real seeders`);
        return j(res, 409, { error_kind: "dead_swarm", human_readable: `no live seeders (${seeders}) — try another source`, seeders });
      }
      const out = await BE.add(hash, { body: /x-bittorrent/i.test(ctype) ? buf : buf.toString(), ctype, trackers: trQ });
      // Alternates for engine-side failover (#3): ?alt=<hash>&alt=<hash>
      liveness.set(String(out.id), {
        at: Date.now(), addAt: Date.now(), seeders,
        alts: u.searchParams.getAll("alt").map((h) => h.toLowerCase()).filter((h) => /^[a-f0-9]{40}$/.test(h)),
        focus: [],
      });
      return j(res, 200, { ...out, seeders });
    }
    if (req.method === "GET" && u.pathname === "/torrents") {
      return j(res, 200, { torrents: await BE.list() });
    }
    let m = /^\/torrents\/([^/]+)(?:\/(stats|delete|pause|update_only_files|stream))?(?:\/(\d+))?$/.exec(u.pathname);
    if (m) {
      const key = m[1], op = m[2], idx = m[3] ? Number(m[3]) : null;
      touch(key);
      if (req.method === "GET" && !op) return j(res, 200, await BE.detail(key));
      if (req.method === "GET" && op === "stats") return j(res, 200, await BE.stats(key));
      if (req.method === "POST" && op === "delete") { liveness.delete(String(key)); return j(res, 200, await BE.delete(key)); }
      if (req.method === "POST" && op === "pause") return j(res, 200, await BE.pause(key));
      if (req.method === "POST" && op === "update_only_files") {
        const b = JSON.parse((await body(req)).toString() || "{}");
        setFocus(key, b.only_files || []); // #4 stream-first focus
        return j(res, 200, await BE.onlyFiles(key, b.only_files || []));
      }
      if (req.method === "GET" && op === "stream" && idx !== null) {
        touch(key); // active playback — never clean this up
        const f = await BE.streamPath(key, idx);
        return serveFile(res, f, req.headers.range, req.method);
      }
    }
    if (u.pathname === "/") return j(res, 200, { ok: true, engine: "Riptide", backend: CFG.backend, compat: "rqbit", features: ["seeder-gate", "failover", "stream-first", "idle-cleanup"] });
    return j(res, 404, { error: "not found" });
  } catch (e) {
    return j(res, 500, { error_kind: "internal_error", human_readable: String(e?.message || e).slice(0, 120) });
  }
}).listen(PORT, () => console.log(`Riptide (${CFG.backend}) on http://127.0.0.1:${PORT}`));
