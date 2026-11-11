import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { findFfmpeg } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HLS_ROOT = path.join(process.cwd(), ".data", "hls");

/**
 * ffmpeg never talks to the internet directly: some ffmpeg builds (static npm
 * copies, seen on Raspberry Pi OS) cannot do DNS at all. Instead it reads from
 * our own /api/tv/play proxy on 127.0.0.1 — a literal IP that needs no name
 * resolution — and Node (which resolves fine) fetches the provider upstream,
 * Range headers included. Works with any ffmpeg binary, anywhere.
 * Local targets (torrent engine, /api routes) already are local.
 */
function localProxyTarget(abs, reqHost) {
  const port = (reqHost || "").includes(":") ? reqHost.split(":").pop() : "3000";
  return `http://127.0.0.1:${port}/api/tv/play?u=${encodeURIComponent(abs)}`;
}

/**
 * One ffmpeg child per URL at a time — when a new request comes for the same
 * URL (channel switch, player reload), the old instance is killed to stop CPU burn.
 */
const active = new Map();

function killStale(url) {
  for (const [oldUrl, child] of active) {
    if (oldUrl !== url && !child.killed) child.kill("SIGKILL");
    active.delete(oldUrl);
  }
}

/**
 * Hardware encode beats CPU encode 5:1 on ultrabook CPUs. Probe ffmpeg's
 * encoders once and prefer, in order: Intel QuickSync (h264_qsv),
 * NVIDIA NVENC, AMD AMF, then CPU (libx264).
 */
/**
 * Hardware encode beats CPU encode 5:1 on ultrabook CPUs. Probe ffmpeg's
 * encoders once and prefer, in order: Intel QuickSync (h264_qsv),
 * NVIDIA NVENC, AMD AMF, Pi v4l2m2m, then CPU (libx264).
 *
 * A name in "-encoders" only means the build knows the encoder — not that
 * the hardware exists. The Pi 5 dropped its H.264 encoder entirely, so
 * h264_v4l2m2m is listed but every real encode dies in ~1 s. Each hardware
 * candidate therefore has to pass a 0.3 s real test-encode before we use it.
 */
let encoderPromise = null;
function encoderWorks(ffmpeg, encoder) {
  return new Promise((resolve) => {
    // 0.3 s synthetic clip; zero-copy encode to null. Fast (~200 ms) and
    // proves the encoder can actually produce frames on this machine.
    const p = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=duration=0.3:size=320x240:rate=10",
      "-c:v", encoder, "-f", "null", "-",
    ], { windowsHide: true, timeout: 10000 });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}
function pickEncoder() {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      const { ffmpeg } = await findFfmpeg();
      const candidates = ["h264_qsv", "h264_nvenc", "h264_amf", "h264_v4l2m2m"];
      return new Promise((resolve) => {
        const p = spawn(ffmpeg, ["-hide_banner", "-encoders"], { windowsHide: true });
        let out = "";
        p.stdout.on("data", (c) => (out += c.toString()));
        p.on("error", () => resolve("libx264"));
        p.on("close", async () => {
          for (const c of candidates) {
            if (new RegExp(c).test(out) && (await encoderWorks(ffmpeg, c))) return resolve(c);
          }
          resolve("libx264");
        });
      });
    })().catch(() => "libx264");
  }
  return encoderPromise;
}

/**
 * Shared transcode pipeline: 720p cap + bitrate cap, hardware encoder when
 * available. mode "mp4" pipes one endless fragmented MP4; mode "hls" writes
 * a live HLS session (short segments + rolling playlist) that every native
 * player — iPhones above all — handles the way apps like UHF/TiviMate do.
 */
function buildArgs(target, encoder, mode, dir, keepAll) {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-user_agent", "HomeStream/1.0 VLC/3.0",
    "-i", target,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-b:v", "2.5M", "-maxrate", "3M", "-bufsize", "5M",
  ];
  if (encoder === "h264_qsv") {
    args.push("-vf", "scale=-2:min(ih\\,720)", "-c:v", "h264_qsv");
  } else if (encoder === "h264_nvenc") {
    args.push("-vf", "scale=-2:min(ih\\,720)", "-c:v", "h264_nvenc", "-preset", "p1");
  } else if (encoder === "h264_amf") {
    args.push("-vf", "scale=-2:min(ih\\,720)", "-c:v", "h264_amf", "-quality", "speed");
  } else if (encoder === "h264_v4l2m2m") {
    // Raspberry Pi video hardware encoder — the only way 1080p transcodes
    // stay watchable on a Pi's small CPU.
    args.push("-vf", "scale=-2:min(ih\\,720)", "-c:v", "h264_v4l2m2m", "-b:v", "2.5M");
  } else {
    // Software encode (the Pi's case — no usable H.264 encoder). 480p + the
    // fastest preset keeps the CPU ahead of realtime so playback never
    // freezes waiting for the next segment. Phone screens hide the
    // difference; dropped frames do not.
    args.push("-vf", "scale=-2:min(ih\\,480)", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency");
  }
  args.push("-c:a", "aac", "-b:a", "160k", "-ac", "2");

  if (mode === "hls") {
    // keepAll (torrents/movies): store every segment for the whole file so
    // the player can rewind to the beginning — like a normal video. At 480p
    // /2.5 Mbps that's ~1.1 GB per hour of movie, deleted when the session
    // goes idle. Live TV keeps the tiny rolling window instead.
    args.push(
      "-f", "hls",
      "-hls_time", "3",
      ...(keepAll
        ? ["-hls_playlist_type", "event", "-hls_list_size", "0", "-hls_flags", "independent_segments"]
        : ["-hls_list_size", "8",
           // NB: no "temp_file" — its rename-into-place is denied on Windows
           // (segment .tmp opens fail) and killed every HLS session mid-movie.
           "-hls_flags", "delete_segments+independent_segments"]),
      "-hls_segment_filename", `${dir}/s%05d.ts`,
      `${dir}/index.m3u8`,
    );
  } else {
    args.push(
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+faststart",
      "pipe:1",
    );
  }
  return args;
}

/** Live HLS sessions: id → { dir, child, last } — pruned when unused. */
const hlsSessions = new Map();

function killHlsStale(id) {
  for (const [oldId, s] of hlsSessions) {
    if (oldId !== id && !s.child.killed) {
      try { s.child.kill("SIGKILL"); } catch {}
      hlsSessions.delete(oldId);
    }
  }
}

let pruneTimer = null;
function startPrune() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of hlsSessions) {
      if (now - s.last > 10 * 60 * 1000) {
        try { s.child.kill("SIGKILL"); } catch {}
        fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
        hlsSessions.delete(id);
      }
    }
  }, 60_000);
}

/**
 * GET /api/tv/transcode?u=<stream url>[&f=hls]
 *
 * f=hls     → native-ish HLS restream: ffmpeg writes an endless live
 *             playlist into .data/hls/<id>/ and we redirect the player to
 *             /api/tv/hls/<id>/index.m3u8. What iPhones (and every native
 *             player app) expect.
 * otherwise → browser-friendly fragmented MP4 for <video> src.
 */
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const target = sp.get("u");
  if (!target) return NextResponse.json({ error: "Missing stream url" }, { status: 400 });
  // local torrent-engine paths are allowed too (they're served by this server)
  const host = request.headers.get("host") || new URL(request.url).host;
  const abs = /^https?:\/\//i.test(target) ? target : target.startsWith("/") ? `http://${host}${target}` : null;
  if (!abs) {
    return NextResponse.json({ error: "Only http(s) streams are supported" }, { status: 400 });
  }

  const { ffmpeg } = await findFfmpeg();
  if (!ffmpeg) return NextResponse.json({ error: "ffmpeg is not installed next to the app" }, { status: 500 });
  startPrune();

  const mode = sp.get("f") === "hls" ? "hls" : "mp4";

  if (mode === "hls") {
    const id = crypto.createHash("sha1").update(abs).digest("hex").slice(0, 12);
    const dir = path.join(HLS_ROOT, id);
    await fs.mkdir(dir, { recursive: true });
    killStale(abs);
    killHlsStale(id);

    let s = hlsSessions.get(id);
    if (!s || !s.child || s.child.exitCode !== null || s.child.killed) {
      const encoder = await pickEncoder();
      const feed = localProxyTarget(abs, request.headers.get("host"));
      // Torrent/movie sources get a full-history playlist (rewind works);
      // live TV keeps the rolling window.
      const keepAll = /\/api\/torrent\/stream/.test(feed);
      const child = spawn(ffmpeg, buildArgs(feed, encoder, "hls", dir, keepAll), { windowsHide: true });
      s = { dir, child, last: Date.now() };
      hlsSessions.set(id, s);
      child.stderr.on("data", (d) => {
        const tail = d.toString().slice(-300);
        if (tail.trim()) console.error(`[hls ${id}] ffmpeg: ${tail}`.replace(/\n+/g, " | "));
      });
      child.on("close", (code, sig) => {
        if (sig === "SIGKILL" || code === 0) return; // intentional stop / clean exit
        console.error(`[hls ${id}] ffmpeg exited code=${code} sig=${sig}`);
        if (hlsSessions.get(id)?.child === child) hlsSessions.delete(id);
      });
    } else {
      s.last = Date.now();
    }

    // Wait until ffmpeg has emitted a real live playlist (first segment
    // done). Big movie files on the Pi can take ~30 s before that first
    // piece — 12 s was killing every iPhone playback of VOD/TV titles.
    const playlist = path.join(dir, "index.m3u8");
    for (let waited = 0; waited < 30000; waited += 400) {
      const txt = await fs.readFile(playlist, "utf8").catch(() => null);
      if (txt && txt.includes("#EXTINF")) break;
      if (s.child.exitCode !== null) {
        return NextResponse.json(
          { error: "ffmpeg could not restream this source — it may be offline" },
          { status: 502 },
        );
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const ready = await fs.readFile(playlist, "utf8").catch(() => null);
    if (!ready || !ready.includes("#EXTINF")) {
      try { s.child.kill("SIGKILL"); } catch {}
      hlsSessions.delete(id);
      return NextResponse.json({ error: "Channel did not start converting in time — try again or another channel" }, { status: 504 });
    }

    // Redirect so the player loads the playlist at its canonical path and
    // relative segment URLs resolve to /api/tv/hls/<id>/….
    // Echo the Host the client actually used (never the raw bind address,
    // which can be 0.0.0.0 when the server listens on all interfaces).
    const host = request.headers.get("host") || new URL(request.url).host;
    return NextResponse.redirect(new URL(`/api/tv/hls/${id}/index.m3u8`, `http://${host}`), 302);
  }

  killStale(abs);
  // NB: mp4-mode must NOT nuke other hlsSessions — they belong to other
  // viewers/devices (someone else's Live TV). Each prunes itself when idle.

  const encoder = await pickEncoder();
  const feed = localProxyTarget(abs, request.headers.get("host"));
  const child = spawn(ffmpeg, buildArgs(feed, encoder, "mp4"), { windowsHide: true });
  active.set(abs, child);

  let stderrTail = "";
  child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-500); });
  child.on("error", (err) => stderrTail += `\nspawn error: ${err.message}`);
  child.on("close", () => active.delete(abs));

  // Give ffmpeg a moment to fail fast on unreachable/garbage input.
  await new Promise((r) => setTimeout(r, 250));
  if (child.exitCode !== null) {
    return NextResponse.json({ error: `ffmpeg could not read the stream: ${stderrTail || "unknown error"}` }, { status: 502 });
  }

  const web = Readable.toWeb(child.stdout);
  return new Response(web, {
    headers: {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
    },
  });
}
