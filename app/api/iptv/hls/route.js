import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { findFfmpeg } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/iptv/hls?index=<n> — proper live HLS for a saved channel.
 * ffmpeg reads the (raw .ts or m3u8) provider stream and cuts real 4-second
 * segments + a rolling playlist. Strict players (Samsung TV) need this:
 * they won't play a fake playlist pointing at a never-ending TS stream.
 *
 * GET /api/iptv/hls?index=<n>&seg=<file> — serve a generated segment.
 */
const SEG_SEC = 4;
const PLAYLIST_SEC = 20;   // keep ~5 segments
const running = new Map(); // index → { dir, proc, at }

async function getChannel(index) {
  let data = null;
  try { data = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "iptv.json"), "utf8")); } catch {}
  return (data?.channels || [])[index];
}

function startSegmenter(index, url, ffmpeg) {
  const dir = path.join(os.tmpdir(), `hs-hls-${index}`);
  nodeFs.mkdirSync(dir, { recursive: true });
  // -re: read at realtime; copy video (no re-encode — H.264 already TV-safe),
  // cut into segments, rolling playlist.
  const args = [
    "-hide_banner", "-loglevel", "error", "-re",
    "-i", url,
    "-c", "copy", "-f", "hls",
    "-hls_time", String(SEG_SEC),
    "-hls_list_size", String(PLAYLIST_SEC / SEG_SEC),
    "-hls_flags", "delete_segments+append_list",
    "-hls_segment_filename", path.join(dir, "seg%05d.ts"),
    path.join(dir, "index.m3u8"),
  ];
  const proc = spawn(ffmpeg, args, { stdio: "ignore", windowsHide: true });
  const entry = { dir, proc, at: Date.now() };
  running.set(index, entry);
  proc.on("exit", () => { if (running.get(index) === entry) running.delete(index); });
  // Idle cap: kill only if NO viewer has fetched the playlist recently. The
  // playlist handler below refreshes entry.at on every request, so an active
  // 6+ hour stream stays alive; an abandoned one is reclaimed after 10 min.
  const idleCheck = () => {
    if (running.get(index) !== entry) return;
    if (Date.now() - entry.at > 10 * 60 * 1000) { try { proc.kill(); } catch {} running.delete(index); }
    else setTimeout(idleCheck, 10 * 60 * 1000).unref?.();
  };
  setTimeout(idleCheck, 10 * 60 * 1000).unref?.();
  return entry;
}

export async function GET(request) {
  try {
    return await hlsHandler(request);
  } catch (e) {
    console.error("[hls] exception:", String(e?.stack || e).slice(0, 300));
    return NextResponse.json({ error: `HLS error: ${String(e?.message || e).slice(0, 120)}` }, { status: 500 });
  }
}

async function hlsHandler(request) {
  const sp = new URL(request.url).searchParams;
  const index = Number(sp.get("index"));
  if (!Number.isInteger(index) || index < 0) return NextResponse.json({ error: "Provide a channel index" }, { status: 400 });

  const host = request.headers.get("host") || "localhost:3000";
  const proto = (request.headers.get("x-forwarded-proto") || "http").split(",")[0];
  const self = `${proto}://${host}`;

  const seg = sp.get("seg");
  if (seg) {
    // Only allow simple segment filenames we generated.
    if (!/^seg\d+\.ts$/.test(seg)) return NextResponse.json({ error: "Bad segment" }, { status: 400 });
    const e = running.get(index);
    if (!e) return NextResponse.json({ error: "No active stream" }, { status: 404 });
    try {
      const buf = await fs.readFile(path.join(e.dir, seg));
      return new Response(buf, { headers: { "Content-Type": "video/mp2t", "Cache-Control": "no-store" } });
    } catch { return NextResponse.json({ error: "Segment not ready" }, { status: 404 }); }
  }

  const ch = await getChannel(index);
  if (!ch?.url) return NextResponse.json({ error: "Channel not found" }, { status: 404 });

  let e = running.get(index);
  if (!e || e.proc.exitCode !== null) {
    const found = await findFfmpeg();
    const ffmpeg = typeof found === "string" ? found : found?.ffmpeg;
    if (!ffmpeg) return NextResponse.json({ error: "ffmpeg not available for HLS segmentation" }, { status: 502 });
    e = startSegmenter(index, ch.url, ffmpeg);
  }

  e.at = Date.now(); // a viewer is here — refresh idle timer
  // Wait briefly for the first segments to be written.
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fs.readFile(path.join(e.dir, "index.m3u8"), "utf8");
      if (/#EXTINF/.test(list)) {
        // Rewrite absolute/relative segment lines → our own endpoint.
        const rewritten = list.split(/\r?\n/).map((line) => {
          const t = line.trim();
          if (!t || t.startsWith("#")) return t;
          return `${self}/api/iptv/hls?index=${index}&seg=${encodeURIComponent(path.basename(t.replace(/^.*\//, "")))}`;
        }).join("\n");
        return new Response(rewritten, { headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" } });
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return NextResponse.json({ error: "Stream not ready yet" }, { status: 504 });
}
