import { NextResponse } from "next/server";
import { getTorrent, pickVideoFile, prioritizePieces } from "@/lib/torrent";
import { qbEnsureTorrent, qbReadRange, qbAvailable, qbTorrentProgress } from "@/lib/qbittorrent";
import { rqEnsureTorrent, rqAvailable, rqWaitForData } from "@/lib/rqbit";
import path from "node:path";
import fs from "node:fs/promises";
import { touchStream, openStream, closeStream } from "@/lib/idleTorrents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Space floor: refuse new torrents when free space is below this.
 *  Writing to a 100%-full SD card is how the fs bitmap got corrupted (2026-11-13). */
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

async function freeSpaceBytes() {
  try {
    const st = await fs.statfs(process.cwd());
    return st.bavail * st.bsize;
  } catch {
    return Infinity; // don't block playback if statfs is unavailable
  }
}

/**
 * Wrap a response body so the janitor can see a LIVE connection. A player
 * (Debrify especially) opens ONE long-lived Range connection for a whole
 * movie — zero new HTTP requests while it reads — so request-counting alone
 * let the janitor delete an actively-watched stream (Between the Lions,
 * 2026-11-17). This wrapper: registers the connection at open, refreshes the
 * liveness lease on EVERY chunk that flows, and deregisters on close/cancel.
 */
function trackStream(source, infoHash) {
  const web = source instanceof ReadableStream ? source : ReadableStream.from(source);
  return web.pipeThrough(
    new TransformStream({
      start() { openStream(infoHash); },
      transform(chunk, controller) {
        touchStream(infoHash); // every flowing chunk = still watching
        controller.enqueue(chunk);
      },
      cancel() { closeStream(infoHash); },
      flush() { closeStream(infoHash); },
    })
  );
}

const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
  ".ts": "video/mp2t", ".flv": "video/x-flv", ".mpg": "video/mpeg", ".wmv": "video/x-ms-wmv",
};

/** Pull the head and tail of the focused file through rqbit's stream endpoint. */
async function warmHeadTail(streamUrl, size) {
  const H = { "User-Agent": "HomeStream/1.0 VLC/3.0" };
  const grab = async (range) => {
    try {
      const res = await fetch(streamUrl, { headers: { ...H, Range: range }, signal: AbortSignal.timeout(120000) });
      if (res.ok || res.status === 206) await res.arrayBuffer();
      else await res.body?.cancel();
    } catch {}
  };
  const tailStart = Math.max(0, (Number(size) || 0) - 1048576);
  await Promise.allSettled([
    grab("bytes=0-1048575"),
    Number(size) > 2097152 ? grab(`bytes=${tailStart}-${Number(size) - 1}`) : Promise.resolve(),
  ]);
}

/** Serve a byte range out of a qB-downloaded file (shared by the fallback
 *  engine and the qB pre-check short-circuit). */
async function serveFromQb(q, rangeHeader) {
  touchStream(q.qbHash || "");
  const ext = path.extname(q.name).toLowerCase();
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const m = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = (m && m[2] ? parseInt(m[2], 10) : Math.max(q.size - 1, 0));
  if (isNaN(start) || start > end) start = 0;
  end = Math.min(end, q.size - 1);
  headers["Content-Range"] = `bytes ${start}-${end}/${q.size}`;
  headers["Content-Length"] = String(end - start + 1);
  const node = qbReadRange(q.filePath, start, end);
  return new Response(trackStream(node, q.qbHash || ""), { status: 206, headers });
}

/** ---- Engine 1: TorrServer (lightweight torrent→HTTP proxy, RAM cache) ---- */
/** Reuse an already-running TorrServer, or spawn one. Returns true if the
 *  HTTP API answers on 127.0.0.1:8090. */
let tsProc = null; // module-level: one shared TorrServer process
async function ensureTorrServer() {
  // Already running?
  try {
    const probe = await fetch("http://127.0.0.1:8090/", { signal: AbortSignal.timeout(2000) });
    if (probe.ok || probe.status === 404) return true; // API is up
  } catch {}
  // Spawn it (detached — survives independently of this request).
  // systemd services don't read /etc/environment and have a minimal PATH,
  // so try the explicit install path first, then PATH.
  const candidates = [
    process.env.HS_TORRSERVER_BIN,
    "/usr/local/bin/torrserver",
    "/usr/bin/torrserver",
    "torrserver",
  ].filter(Boolean);
  const { spawn } = await import("node:child_process");
  let spawned = false;
  for (const binary of candidates) {
    try {
      tsProc = spawn(binary, ["-c", `${process.env.HOME || "/home/ctorres19956"}/config.yaml`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      tsProc.on("error", () => {}); // ignore ENOENT from wrong candidate
      tsProc.unref();
      spawned = true;
      break;
    } catch {}
  }
  if (!spawned) return false;
  // Wait for the API to come up (max 8s)
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const probe = await fetch("http://127.0.0.1:8090/", { signal: AbortSignal.timeout(1500) });
      if (probe.ok || probe.status === 404) return true;
    } catch {}
  }
  return false;
}

async function tryTorrServer(infoHash, rangeHeader, trackers = [], nameHint = "") {
  const up = await ensureTorrServer();
  if (!up) throw new Error("torrserver binary not found or API not responding");
  // Register as a MAGNET LINK with trackers + display name — a bare hash gets
  // no tracker announcements, so the swarm stays at 0 peers and metadata never
  // loads (stat:0, torrent_size:0 — TorrServer test, 2026-11-18).
  const magnet = `magnet:?xt=urn:btih:${infoHash}` +
    (nameHint ? `&dn=${encodeURIComponent(nameHint.trim())}` : "") +
    trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  await fetch(`http://127.0.0.1:8090/api/torrents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "HomeStream/1.0" },
    body: JSON.stringify({ link: magnet }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  // Wake the torrent so metadata resolution starts immediately.
  await fetch(`http://127.0.0.1:8090/api/torrents/${infoHash}/wake`, {
    method: "POST", signal: AbortSignal.timeout(5000),
  }).catch(() => {});
  // Phase 1 — wait for METADATA (torrent_size > 0). Without it the file list
  // is empty and /api/stream/{hash}/{idx} returns 404 (observed 2026-11-18:
  // swarm delivered metadata ~60s in, after our 45s warm-up had given up).
  const warmStart = Date.now();
  let meta = null;
  while (Date.now() - warmStart < 90000) {
    try {
      const list = await fetch(`http://127.0.0.1:8090/api/torrents`, {
        signal: AbortSignal.timeout(3000),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const t = (list?.torrents || []).find((x) => String(x.hash).toLowerCase() === infoHash);
      if (t && Number(t.torrent_size) > 0) { meta = t; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!meta) throw new Error("torrserver metadata not ready after 90s (dead swarm)");
  // Phase 2 — pick the RIGHT file: fetch the file list and match the name
  // hint (S01E02 etc.). Hardcoding index 0 hit 404s / wrong files in packs.
  let fileIdx = 0;
  try {
    const det = await fetch(`http://127.0.0.1:8090/api/torrents/${infoHash}`, {
      signal: AbortSignal.timeout(5000),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const files = det?.files || det?.file_list || det?.FileList || [];
    if (files.length) {
      const VIDEO = /\.(mp4|mkv|avi|mov|webm|ts|m4v)$/i;
      const videos = files.map((f, i) => ({ f, i })).filter(({ f }) =>
        VIDEO.test(String(f.path || f.name || f.Path || f.Name || "")));
      const hint = nameHint.toLowerCase().trim();
      const epM = /s(\d{1,2})[._ -]?e(\d{1,3})/i.exec(hint);
      let pickIdx = -1;
      if (epM) {
        const tag = `s${String(Number(epM[1])).padStart(2, "0")}e${String(Number(epM[2])).padStart(2, "0")}`;
        pickIdx = videos.find(({ f }) =>
          String(f.path || f.name || f.Path || f.Name || "").toLowerCase().replace(/[._ -]/g, "")
            .includes(tag.replace(/[._ -]/g, "")))?.i ?? -1;
      }
      if (pickIdx < 0 && videos.length) pickIdx = videos[0].i; // first video file
      if (pickIdx >= 0) fileIdx = pickIdx;
    }
  } catch {}
  // Phase 3 — preload the chosen file and wait for first bytes so the player
  // doesn't freeze on an empty RAM cache.
  await fetch(`http://127.0.0.1:8090/api/torrents/${infoHash}/files/${fileIdx}/preload`, {
    method: "POST", signal: AbortSignal.timeout(5000),
  }).catch(() => {});
  const byteStart = Date.now();
  let hasBytes = false;
  while (Date.now() - byteStart < 45000) {
    if (Number(meta.bytes_written || 0) > 0) { hasBytes = true; break; }
    try {
      const list = await fetch(`http://127.0.0.1:8090/api/torrents`, {
        signal: AbortSignal.timeout(3000),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const t = (list?.torrents || []).find((x) => String(x.hash).toLowerCase() === infoHash);
      if (t && Number(t.bytes_written || 0) > 0) { hasBytes = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!hasBytes) console.error(`[stream] TorrServer: no bytes after preload — serving anyway (slow swarm)`);
  const streamUrl = `http://127.0.0.1:8090/api/stream/${infoHash}/${fileIdx}`;
  // Stream from TorrServer — it serves Range requests from RAM cache
  const H = { "User-Agent": "HomeStream/1.0 VLC/3.0" };
  const res = await fetch(streamUrl, {
    headers: { ...H, ...(rangeHeader ? { Range: rangeHeader } : {} ) },
    signal: AbortSignal.timeout(120000),
  });
  if (res.ok) {
    return new Response(res.body, { status: res.status === 206 ? 206 : 200,
      headers: {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      } });
  }
  throw new Error(`torrserver returned ${res.status} for file ${fileIdx}`);
}

/** GET /api/torrent/stream?infoHash=<40-hex> — proxies a BitTorrent file as
 * chunkable HTTP video (206 Range requests), exactly like Stremio's local
 * stream server. First play needs swarm peers, so it can take a while to
 * reach playable speed; browsers just see a normal byte stream.
 *
 * Engine order: qBittorrent (if configured in .data/qbittorrent.json) is the
 * preferred engine — sequential downloading makes streaming fast. webtorrent
 * (in-process) is the automatic fallback when qB isn't configured/working.
 * TorrServer (RAM-cache, instant start) is tried before webtorrent if the
 * binary is available via HS_TORRSERVER_BIN.
 */
/** Serve a byte range out of a TorrServer-served torrent. */
async function serveFromTorrServer(infoHash, rangeHeader, trackers, nameHint) {
  const resp = await tryTorrServer(infoHash, rangeHeader, trackers, nameHint);
  return resp; // Response on success, throws on failure
}

/** Engine decision: try each engine in order, returning the first successful Response. */
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const infoHash = ((sp.get("infoHash")) || "").toLowerCase();
  const nameHint = sp.get("name") + " " + (sp.get("ep") || "").toUpperCase(); // "S01E02" helps pick the right file in season packs
  const trackers = sp.getAll("tr"); // addon-injected trackers (Stremio's trick) — declared early: engines below reference it before the old line-304 spot (TDZ ReferenceError silently killed the qB pre-check)
  const rangeHeader = request.headers.get("range");
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    return NextResponse.json({ error: "Provide a valid 40-char infoHash" }, { status: 400 });
  }

  // Space-floor guardrail: never start a torrent write when the disk is
  // nearly full. Fails fast with a visible message instead of filling the
  // card to zero and breaking the filesystem.
  const free = await freeSpaceBytes();
  if (free < MIN_FREE_BYTES) {
    console.error(`[stream] SPACE FLOOR: ${(free / 1e9).toFixed(1)} GB free < 5 GB — refusing torrent ${infoHash.slice(0, 10)}…`);
    return NextResponse.json(
      { error: `Server disk almost full (${(free / 1e9).toFixed(1)} GB free). Torrents are deleted when you close a player — close open players and try again.` },
      { status: 507 },
    );
  }

  // ---- Engine pre-check: if qB already holds this torrent with data, serve
  // from it FIRST. Fallback engines keep state across retry storms; knocking
  // on rqbit first would re-register a magnet on a weak swarm and burn the
  // client's patience re-resolving metadata that qB already has on disk.
  try {
    const pre = await qbTorrentProgress(infoHash);
    if (pre && pre.progress > 0) {
      console.log(`[stream] qB pre-check hit: torrent already at ${Math.round(pre.progress * 100)}% — serving from qB directly`);
      const q = await qbEnsureTorrent({ infoHash, nameHint, trackers, waitMs: 15000 });
      if (q) {
        touchStream(infoHash);
        return await serveFromQb(q, rangeHeader);
      }
    }
  } catch {}

  // ---- Engine 1: TorrServer (RAM-cache, instant start) -----------------------
  try {
    const resp = await serveFromTorrServer(infoHash, rangeHeader, trackers, nameHint);
    if (resp) {
      console.log(`[stream] TorrServer engine serving ${infoHash.slice(0, 8)}… (RAM cache)`);
      return resp;
    }
    throw new Error("no response");
  } catch (e) {
    console.error(`[stream] TorrServer engine failed (${String(e).slice(0, 150)}) — trying rqbit`);
  }

  // ---- Engine 2: rqbit (librqbit) — fallback ----------------------------------
  try {
    const r = await rqEnsureTorrent({ infoHash, nameHint, trackers });
    if (r) {
      console.log(`[stream] rqbit engine serving ${r.name} (${Math.round(r.size / 1048576)} MB)`);
      touchStream(infoHash); // ledger: a client is reading this torrent
      // Warm-up hold: rqbit's stream endpoint answers with headers even when
      // zero pieces exist. Clients with aggressive connect timeouts (Debrify)
      // see "no data" and quit — so hold here until the first bytes land
      // (same treatment the webtorrent path always had).
      const rid = r.streamUrl.split("/torrents/")[1]?.split("/")[0];
      const warmed = await rqWaitForData(rid, infoHash, 60000);
      if (!warmed) console.error(`[stream] rqbit: no first bytes after 60s — serving ${r.name} anyway (client may still connect)`);
      // Force the head+tail pieces to exist: fire-and-forget, the response
      // streams as soon as THIS range has data.
      warmHeadTail(r.streamUrl, r.size).catch(() => {});
      // rqbit's /stream/{fileIdx} endpoint handles Range itself — pipe it
      // through directly. (Redirecting used to hand the client the server's
      // BIND address — http://0.0.0.0:3000/... — which no player can fetch,
      // so every rqbit-served movie died before playing. Piping also drops
      // one network hop.)
      const upstream = await fetch(r.streamUrl, {
        headers: { "User-Agent": "HomeStream/1.0 VLC/3.0", ...(rangeHeader ? { Range: rangeHeader } : {}) },
        redirect: "follow",
      });
      if (!upstream.ok && upstream.status !== 206) {
        throw new Error(`rqbit stream endpoint returned HTTP ${upstream.status}`);
      }
      const ext = path.extname(r.name).toLowerCase();
      const headers = {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      };
      for (const h of ["Content-Length", "Content-Range"]) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      return new Response(trackStream(upstream.body, infoHash), { status: upstream.status === 206 ? 206 : 200, headers });
    }
  } catch (e) {
    const stack = String(e?.stack || "").split("\n").slice(0, 3).join(" | ");
    console.error(`[stream] rqbit engine failed (${String(e).slice(0, 120)}) at ${stack} — trying qBittorrent`);
  }

  // ---- Engine 3: qBittorrent (proven fallback) --------------------------------
  try {
    const q = await qbEnsureTorrent({ infoHash, nameHint, trackers });
    if (q) {
      console.log(`[stream] qBittorrent engine serving ${q.name} (${Math.round(q.size / 1048576)} MB)`);
      return await serveFromQb(q, rangeHeader);
    }
  } catch (e) {
    console.error(`[stream] qBittorrent engine failed (${String(e).slice(0, 120)}) — falling back to webtorrent`);
  }

  // ---- Engine 4: webtorrent ---------------------------------------------------
  if (!(await qbAvailable())) console.log("[stream] qbittorrent not configured — using webtorrent engine");
  let t, pick;
  try {
    t = await getTorrent(infoHash);
    pick = pickVideoFile(t, nameHint);
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Torrent failed" }, { status: 504 });
  }
  if (!pick) {
    return NextResponse.json({ error: "No playable video file inside this torrent" }, { status: 400 });
  }

  t._hsTouch = Date.now();
  touchStream(infoHash); // ledger: a client is reading this torrent
  const file = pick.file;
  prioritizePieces(t, file); // aim the swarm at this file's pieces
  // External players (VLC/Infuse) give up fast when connected to a stream
  // that sends headers but no data. If nothing has downloaded yet, hold the
  // response until the first piece arrives so the player's connect timeout
  // starts counting against real bytes, not silence.
  if (!t.downloaded && !t.received) {
    await new Promise((resolve) => {
      const started = Date.now();
      const check = setInterval(() => {
        if (t.downloaded > 0 || t.received > 0 || Date.now() - started > 90_000) {
          clearInterval(check);
          resolve();
        }
      }, 500);
      t.once?.("ready", () => { clearInterval(check); resolve(); });
    });
  }
  const ext = pick.ext;
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };

  if (!rangeHeader) {
    headers["Content-Length"] = String(file.length);
    return new Response(trackStream(file.stream(), infoHash), { status: 200, headers });
  }

  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  // Open-ended requests must stream all the way to EOF. Capping them (the old
  // 4MB cap) made transcoders like ffmpeg hit EOF and abort mid-convert, and
  // stalled every HLS session after 3 segments.
  let end = m && m[2] ? parseInt(m[2], 10) : file.length - 1;
  if (isNaN(start) || start > end || end >= file.length) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.length}` } });
  }
  headers["Content-Range"] = `bytes ${start}-${end}/${file.length}`;
  headers["Content-Length"] = String(end - start + 1);

  const node = file.createReadStream({ start, end });
  return new Response(trackStream(node, infoHash), { status: 206, headers });
}