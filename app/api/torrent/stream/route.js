import { NextResponse } from "next/server";
import { getTorrent, pickVideoFile, prioritizePieces } from "@/lib/torrent";
import { qbEnsureTorrent, qbReadRange, qbAvailable } from "@/lib/qbittorrent";
import { rqEnsureTorrent, rqAvailable } from "@/lib/rqbit";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
  ".ts": "video/mp2t", ".flv": "video/x-flv", ".mpg": "video/mpeg", ".wmv": "video/x-ms-wmv",
};

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
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const infoHash = ((sp.get("infoHash")) || "").toLowerCase();
  const nameHint = sp.get("name") + " " + (sp.get("ep") || "").toUpperCase(); // "S01E02" helps pick the right file in season packs
  const rangeHeader = request.headers.get("range");
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    return NextResponse.json({ error: "Provide a valid 40-char infoHash" }, { status: 400 });
  }

  // ---- Engine 1: rqbit (librqbit) — the lightweight primary -------------------
  try {
    const r = await rqEnsureTorrent({ infoHash, nameHint });
    if (r) {
      console.log(`[stream] rqbit engine serving ${r.name} (${Math.round(r.size / 1048576)} MB)`);
      // rqbit's /stream/{fileIdx} endpoint handles Range itself — proxy it.
      const proxied = `/api/tv/play?u=${encodeURIComponent(r.streamUrl)}`;
      return NextResponse.redirect(new URL(proxied, request.url), 302);
    }
  } catch (e) {
    console.error(`[stream] rqbit engine failed (${String(e).slice(0, 120)}) — trying qBittorrent`);
  }

  // ---- Engine 2: qBittorrent (proven fallback) --------------------------------
  try {
    const q = await qbEnsureTorrent({ infoHash, nameHint });
    if (q) {
      console.log(`[stream] qBittorrent engine serving ${q.name} (${Math.round(q.size / 1048576)} MB)`);
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
