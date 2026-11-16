import { NextResponse } from "next/server";
import { getTorrent, pickVideoFile, prioritizePieces } from "@/lib/torrent";
import { qbEnsureTorrent, qbReadRange, qbAvailable, qbTorrentProgress } from "@/lib/qbittorrent";
import { rqEnsureTorrent, rqAvailable, rqWaitForData } from "@/lib/rqbit";
import path from "node:path";
import fs from "node:fs/promises";
import { touchStream } from "@/lib/idleTorrents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Space floor: refuse new torrents when free space is below this. Writing
 *  to a 100%-full SD card is how the fs bitmap got corrupted (2026-11-13). */
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

async function freeSpaceBytes() {
  try {
    const st = await fs.statfs(process.cwd());
    return st.bavail * st.bsize;
  } catch {
    return Infinity; // don't block playback if statfs is unavailable
  }
}

const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
  ".ts": "video/mp2t", ".flv": "video/x-flv", ".mpg": "video/mpeg", ".wmv": "video/x-ms-wmv",
};

/**
 * Pull the head and tail of the focused file through rqbit's stream endpoint.
 * rqbit downloads pieces on demand — HTTP reads act as prioritization hints.
 * A player needs the FILE HEAD (start) and the TAIL (mkv seek index/cues);
 * without this, "any bytes fetched" can be the tail (from an earlier probe)
 * while the head starves and playback never starts (Fear Factor ep3,
 * 2026-11-16: end-range served instantly, start-range hung forever).
 */
async function warmHeadTail(streamUrl, size) {
  const H = { "User-Agent": "HomeStream/1.0 VLC/3.0" };
  const grab = async (range) => {
    try {
      const res = await fetch(streamUrl, { headers: { ...H, Range: range }, signal: AbortSignal.timeout(120000) });
      if (res.ok || res.status === 206) await res.arrayBuffer(); // pull the bytes through
      else await res.body?.cancel();
    } catch {}
  };
  const tailStart = Math.max(0, (Number(size) || 0) - 1048576);
  await Promise.allSettled([
    grab("bytes=0-1048575"),
    Number(size) > 2097152 ? grab(`bytes=${tailStart}-${Number(size) - 1}`) : Promise.resolve(),
  ]);
}

/**
 * GET /api/torrent/stream?infoHash=<40-hex> — proxies a BitTorrent file as
 * chunkable HTTP video (206 Range requests), exactly like Stremio's local
 * stream server. First play needs swarm peers, so it can take a while to
 * reach playable speed; browsers just see a normal byte stream.
 *
 * Engine order: qBittorrent (if configured in .data/qbittorrent.json) is the
 * preferred engine — sequential downloading makes streaming fast. webtorrent
 * (in-process) is the automatic fallback when qB isn't configured/working.
 */
/** Serve a byte range out of a qB-downloaded file (shared by the fallback
 *  engine and the qB pre-check short-circuit). */
async function serveFromQb(q, rangeHeader) {
  touchStream(q.qbHash || ""); // ledger: a client is reading this torrent
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
  return new Response(node, { status: 206, headers });
}

export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const infoHash = ((sp.get("infoHash")) || "").toLowerCase();
  const nameHint = sp.get("name") + " " + (sp.get("ep") || "").toUpperCase(); // "S01E02" helps pick the right file in season packs
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

  // ---- Engine 1: rqbit (librqbit) — the lightweight primary -------------------
  const trackers = sp.getAll("tr"); // addon-injected trackers (Stremio's trick)
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
      return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
    }
  } catch (e) {
    const stack = String(e?.stack || "").split("\n").slice(0, 3).join(" | ");
    console.error(`[stream] rqbit engine failed (${String(e).slice(0, 120)}) at ${stack} — trying qBittorrent`);
  }

  // ---- Engine 2: qBittorrent (proven fallback) --------------------------------
  try {
    const q = await qbEnsureTorrent({ infoHash, nameHint, trackers });
    if (q) {
      console.log(`[stream] qBittorrent engine serving ${q.name} (${Math.round(q.size / 1048576)} MB)`);
      return await serveFromQb(q, rangeHeader);
    }
  } catch (e) {
    console.error(`[stream] qBittorrent engine failed (${String(e).slice(0, 120)}) — falling back to webtorrent`);
  }

  // ---- Engine 3: webtorrent ---------------------------------------------------
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
    return new Response(file.stream(), { status: 200, headers });
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
  return new Response(node, { status: 206, headers });
}
