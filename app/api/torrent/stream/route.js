import { NextResponse } from "next/server";
import { getTorrent, pickVideoFile, prioritizePieces } from "@/lib/torrent";
import { qbEnsureTorrent, qbReadRange, qbAvailable } from "@/lib/qbittorrent";
import { rqEnsureTorrent, rqAvailable, rqWaitForData, riptideHost } from "@/lib/rqbit";
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

/** Serve a byte range out of a qB-downloaded file (shared by the fallback
 *  the qB engine). */
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

/** GET /api/torrent/stream?infoHash=<40-hex> — proxies a BitTorrent file as
 * chunkable HTTP video (206 Range requests), exactly like Stremio's local
 * stream server. First play needs swarm peers, so it can take a while to
 * reach playable speed; browsers just see a normal byte stream.
 *
 * Engine order: rqbit (primary — self-healed by the watchdog), then
 * qBittorrent → webtorrent as fallbacks.
 */

/** Negative cache: a hash whose rqbit engine failed twice in a row is skipped
 * for 90s, so a player's 5-10s retry storm can't hammer a wedged daemon while
 * the watchdog prepares a restart. ONE failure never skips rqbit — a transient
 * timeout must not hand playback to qB, which is now only the fallback. */
function rqFail(name = "rqbit") {
  const g = globalThis;
  if (!g.__hsRqFail) g.__hsRqFail = new Map();
  if (!g.__hsRqFail.has(name)) g.__hsRqFail.set(name, new Map());
  return g.__hsRqFail.get(name);
}
const RQ_FAIL_TTL = 90 * 1000;

/** Engine decision: try each engine in order, returning the first successful Response. */
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const infoHash = ((sp.get("infoHash")) || "").toLowerCase();
  const nameHint = sp.get("name") + " " + (sp.get("ep") || "").toUpperCase(); // "S01E02" helps pick the right file in season packs
  const trackers = sp.getAll("tr"); // addon-injected trackers (Stremio's trick) — declared before the engines below reference it (an earlier TDZ ReferenceError silently killed the qB branch)
  const rangeHeader = request.headers.get("range");
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    return NextResponse.json({ error: "Provide a valid 40-char infoHash" }, { status: 400 });
  }
  // ?engine=<rqbit|qb|webtorrent> — force ONE engine (diagnostic override).
  // Without it the chain runs in order. With it, only that engine is tried and
  // a failure returns 504 instead of falling through, so a test proves which
  // engine actually delivers bytes on a given source (2026-11-18: webtorrent
  // is Engine 3 but had never been reached in isolation).
  const engine = (sp.get("engine") || "").toLowerCase();
  if (engine && !["rqbit", "riptide", "qb", "webtorrent"].includes(engine)) {
    return NextResponse.json({ error: `Unknown engine — use rqbit, riptide, qb, or webtorrent` }, { status: 400 });
  }
  if (engine) console.log(`[stream] engine override: ${engine} forced for ${infoHash.slice(0, 10)}…`);

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

  // ---- Engine 1: Riptide (custom, configured) → rqbit (primary engines) ----
  // Riptide speaks rqbit's API and is tried FIRST when configured in
  // .data/riptide.json. The stock rqbit daemon is the fallback if Riptide
  // isn't configured or fails. qB is only Engine 2 after both fail.
  const riptide = (!engine || engine === "riptide") ? await riptideHost() : null;
  const engines = [];
  if (riptide) engines.push({ name: "Riptide", host: riptide, forced: engine === "riptide" });
  if (!engine || engine === "rqbit") engines.push({ name: "rqbit", host: null, forced: engine === "rqbit" });

  // A forced engine must use that engine alone — if it's unavailable, return
  // 504 instead of silently falling through to qB/webtorrent.
  if (engine === "riptide" && !riptide) {
    return NextResponse.json({ error: "Riptide is not configured (forced ?engine=riptide)" }, { status: 504 });
  }
  for (const eng of engines) {
    const fails = rqFail(eng.name);
    const failEntry = fails.get(infoHash);
    const cooling = failEntry && failEntry.count >= 2 && Date.now() - failEntry.at < RQ_FAIL_TTL;
    if (cooling && !eng.forced) {
      console.log(`[stream] ${eng.name} cooling down after ${failEntry.count} failures — trying next engine`);
      continue;
    }
    try {
      const r = await rqEnsureTorrent({ infoHash, nameHint, trackers, host: eng.host });
      if (r) {
        console.log(`[stream] ${eng.name} engine serving ${r.name} (${Math.round(r.size / 1048576)} MB)`);
        touchStream(infoHash);
        const rid = r.streamUrl.split("/torrents/")[1]?.split("/")[0];
        // Short warm-up only. The resolver already verifies first bytes before
        // returning this URL, so a long 60s hold here is redundant — and with
        // hash-based stream URLs the stats poll can fail, making every play
        // stall ~50s. 8s is a safety net, not a gate.
        const warmed = await rqWaitForData(rid, infoHash, 8000, eng.host);
        if (!warmed) console.error(`[stream] ${eng.name}: no first bytes after 8s — serving ${r.name} anyway`);
        const upstream = await fetch(r.streamUrl, {
          headers: { "User-Agent": "HomeStream/1.0 VLC/3.0", ...(rangeHeader ? { Range: rangeHeader } : {}) },
          redirect: "follow",
        });
        if (!upstream.ok && upstream.status !== 206) throw new Error(`${eng.name} stream endpoint returned HTTP ${upstream.status}`);
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
        fails.delete(infoHash); // engine worked — clear its cooldown
        return new Response(trackStream(upstream.body, infoHash), { status: upstream.status === 206 ? 206 : 200, headers });
      }
    } catch (e) {
      const prev = fails.get(infoHash);
      fails.set(infoHash, { at: Date.now(), count: (prev?.count || 0) + 1, err: String(e?.message || e).slice(0, 80) });
      const stack = String(e?.stack || "").split("\n").slice(0, 3).join(" | ");
      console.error(`[stream] ${eng.name} engine failed (${String(e).slice(0, 120)}) at ${stack} — ${eng.forced ? "forced override, stopping" : "trying next engine"}`);
    }
    if (eng.forced) {
      return NextResponse.json({ error: `${eng.name} engine failed (forced ?engine=${engine})` }, { status: 504 });
    }
  }

  // ---- Engine 2: qBittorrent (fallback — sequential, serves from disk) -----
  // qB is the fallback: sequential download + first/last piece priority, then
  // plain disk reads. qbEnsureTorrent short-circuits when qB already holds a
  // torrent with REAL data (progress>0 guard), so repeat plays stay fast.
  // (?engine= override: skipped unless qb is the forced engine.)
  if (!engine || engine === "qb") {
    try {
      const q = await qbEnsureTorrent({ infoHash, nameHint, trackers });
      if (q) {
        console.log(`[stream] qBittorrent engine serving ${q.name} (${Math.round(q.size / 1048576)} MB)`);
        return await serveFromQb(q, rangeHeader);
      }
    } catch (e) {
      console.error(`[stream] qBittorrent engine failed (${String(e).slice(0, 120)}) — ${engine === "qb" ? "forced override, stopping" : "trying webtorrent"}`);
    }
    if (engine === "qb") {
      return NextResponse.json({ error: "qBittorrent engine failed (forced ?engine=qb)" }, { status: 504 });
    }
  }

  // ---- Engine 3: webtorrent ---------------------------------------------------
  // Reached when nothing was forced, or when webtorrent IS the forced engine.
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