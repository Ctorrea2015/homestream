import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

/**
 * Locates ffmpeg/ffprobe. Order:
 *  1. FFMPEG_PATH / FFPROBE_PATH env vars (absolute exe path)
 *  2. tools/ffmpeg/ next to the app (the bundled copy)
 *  3. npm-installed binaries (ffmpeg-static / ffprobe-static)
 *  4. system PATH ("ffmpeg" plain)
 *
 * Every candidate is verified with a real `-version` run before being used:
 * the npm ffmpeg-static package ships per-architecture binaries that can be
 * broken on some platforms (observed on Raspberry Pi OS — the bundled ARM
 * binary exits instantly, while the system ffmpeg works), so a path existing
 * is not proof the binary runs. Results are cached after the first probe.
 */

let cached = null;
function runs(binary) {
  return new Promise((resolve) => {
    if (!binary) return resolve(false);
    execFile(binary, ["-version"], { timeout: 10000 }, (err) => resolve(!err));
  });
}

/**
 * Some ffmpeg builds (notably the static ones npm ships) cannot resolve DNS
 * at all — every lookup dies with "Failed to resolve hostname ...: System
 * error", while the system ffmpeg works. A binary that can't resolve is
 * useless for our relays, so candidates are probed with a tiny input-open
 * against a known hostname and rejected if the error is DNS-shaped.
 */
function resolvesDns(binary) {
  return new Promise((resolve) => {
    const p = spawn(binary, [
      "-hide_banner", "-loglevel", "error",
      "-i", "http://example.com/", "-t", "0.1", "-f", "null", "-",
    ], { timeout: 12000, windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", () => resolve(false));
    p.on("close", () => resolve(!/Failed to resolve|Name or service not known|Temporary failure in name resolution/i.test(err)));
  });
}

function candidates(kind) {
  const toolsDir = path.join(process.cwd(), "tools", "ffmpeg");
  const list = [];
  const envKey = kind === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) list.push(process.env[envKey]);
  const exe = process.platform === "win32" ? `${kind}.exe` : kind;
  const toolsPath = path.join(toolsDir, exe);
  if (fs.existsSync(toolsPath)) list.push(toolsPath);
  try {
    if (kind === "ffmpeg") {
      const pkg = require("ffmpeg-static");
      if (pkg && fs.existsSync(pkg)) list.push(pkg);
    } else {
      const pkg = require("ffprobe-static")?.path;
      if (pkg && fs.existsSync(pkg)) list.push(pkg);
    }
  } catch {}
  list.push(kind); // system PATH last
  return list;
}

export async function findFfmpeg() {
  if (cached) return cached;

  async function pick(kind) {
    const list = candidates(kind);
    // Pass 1: binary runs AND can resolve a hostname (DNS-broken static
    // builds are skipped). Pass 2: any binary that runs at all, so an
    // offline or locked-down box still gets a working ffmpeg.
    for (const c of list) if ((await runs(c)) && (await resolvesDns(c))) return c;
    for (const c of list) if (await runs(c)) return c;
    return null;
  }

  cached = { ffmpeg: await pick("ffmpeg"), ffprobe: await pick("ffprobe") };
  return cached;
}
