import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HLS_ROOT = path.join(process.cwd(), ".data", "hls");

/**
 * GET /api/tv/hls/<id>/<file>
 * Serves the files a live ffmpeg HLS session writes (index.m3u8, s00001.ts …).
 * `id` is a 12-hex hash of the source url; `file` is whitespace-free output.
 */
export async function GET(_request, { params }) {
  const { id, file } = (await params) || {};

  if (!/^[0-9a-f]{12}$/.test(id || "") || !/^[A-Za-z0-9_-]{1,50}\.(m3u8|ts|mp4|tmp)$/.test(file || "")) {
    return NextResponse.json({ error: "Bad segment path" }, { status: 400 });
  }
  // No path traversal: both parts are validated by strict whitelists above,
  // so joining stays inside .data/hls/<id>/.
  const filePath = path.join(HLS_ROOT, id, file);

  let data;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return NextResponse.json({ error: "Segment not found — the live session may have moved on" }, { status: 404 });
  }

  const type = file.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : file.endsWith(".ts")
      ? "video/mp2t"
      : "video/mp4";

  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
