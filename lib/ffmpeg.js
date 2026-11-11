import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

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

  let ffmpeg = null;
  for (const c of candidates("ffmpeg")) {
    if (await runs(c)) { ffmpeg = c; break; }
  }
  let ffprobe = null;
  for (const c of candidates("ffprobe")) {
    if (await runs(c)) { ffprobe = c; break; }
  }

  cached = { ffmpeg, ffprobe };
  return cached;
}
