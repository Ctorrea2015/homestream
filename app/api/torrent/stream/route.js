import { NextResponse } from "next/server";
import { getTorrent, pickVideoFile } from "@/lib/torrent";

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
 */
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const infoHash = ((sp.get("infoHash")) || "").toLowerCase();
  const nameHint = sp.get("name") || "";
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    return NextResponse.json({ error: "Provide a valid 40-char infoHash" }, { status: 400 });
  }

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
  const ext = pick.ext;
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };

  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) {
    headers["Content-Length"] = String(file.length);
    return new Response(file.stream(), { status: 200, headers });
  }

  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : Math.min(file.length - 1, start + 4 * 1024 * 1024 - 1); // first ~4MB when open-ended
  if (isNaN(start) || start > end || end >= file.length) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.length}` } });
  }
  headers["Content-Range"] = `bytes ${start}-${end}/${file.length}`;
  headers["Content-Length"] = String(end - start + 1);

  const node = file.createReadStream({ start, end });
  return new Response(node, { status: 206, headers });
}
