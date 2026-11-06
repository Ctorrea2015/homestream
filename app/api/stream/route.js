import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME = {
  mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska",
  webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv", flv: "video/x-flv", mpg: "video/mpeg",
  mpeg: "video/mpeg", ts: "video/mp2t", "3gp": "video/3gpp", ogv: "video/ogg",
};

/**
 * GET /api/stream?id=<video id>
 *
 * Supports HTTP Range requests, which is what makes instant seeking,
 * scrubbing and resume work — the browser asks for byte ranges and we
 * serve exactly those, instead of the whole file.
 */
export async function GET(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing video id" }, { status: 400 });

  const lib = await readLibrary();
  const video = lib.videos.find((v) => v.id === id);
  if (!video) return NextResponse.json({ error: "Unknown video" }, { status: 404 });

  let stat;
  try {
    stat = await fsp.stat(video.path);
  } catch {
    return NextResponse.json({ error: "Video file is missing on disk" }, { status: 404 });
  }

  const contentType = MIME[video.ext] || "application/octet-stream";
  const range = request.headers.get("range");

  // Simple, full response for browsers/players that didn't send a Range.
  if (!range) {
    const stream = fs.createReadStream(video.path);
    return new Response(Readable.toWeb(stream), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
      },
    });
  }

  // Parse "bytes=start-end" (both ends are optional).
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) {
    return NextResponse.json({ error: "Invalid Range header" }, { status: 416 });
  }
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;

  if (start >= stat.size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${stat.size}` },
    });
  }

  const stream = fs.createReadStream(video.path, { start, end });
  return new Response(Readable.toWeb(stream), {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
    },
  });
}
