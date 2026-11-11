import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { findFfmpeg } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tv/probe?u=<stream url>
 * Returns { duration } (seconds) for a movie file — powers the real movie
 * timeline in the player (total length, tap-anywhere seek). Reads through
 * the local proxy like everything else (ffmpeg never does DNS).
 */
export async function GET(request) {
  const target = new URL(request.url).searchParams.get("u");
  if (!target) return NextResponse.json({ error: "Missing stream url" }, { status: 400 });
  const host = request.headers.get("host") || new URL(request.url).host;
  const abs = /^https?:\/\//i.test(target) ? target : target.startsWith("/") ? `http://${host}${target}` : null;
  if (!abs) return NextResponse.json({ error: "Only http(s) streams are supported" }, { status: 400 });

  const { ffprobe } = await findFfmpeg();
  if (!ffprobe) return NextResponse.json({ error: "ffprobe not found" }, { status: 500 });

  const port = (host || "").includes(":") ? host.split(":").pop() : "3000";
  const feed = `http://127.0.0.1:${port}/api/tv/play?u=${encodeURIComponent(abs)}`;

  return new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const p = spawn(ffprobe, [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "json",
          feed,
        ], { windowsHide: true });
        let out = "", done = false;
        const finish = () => { if (!done) { done = true; controller.close(); } };
        const timer = setTimeout(finish, 25000); // don't hang on quiet swarms
        p.stdout.on("data", (c) => (out += c.toString()));
        p.on("error", () => { clearTimeout(timer); finish(); });
        p.on("close", () => {
          clearTimeout(timer);
          try {
            const dur = parseFloat(JSON.parse(out)?.format?.duration);
            controller.enqueue(enc.encode(JSON.stringify({ duration: isFinite(dur) ? dur : null })));
          } catch { /* close without a body */ }
          finish();
        });
      },
    }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}
