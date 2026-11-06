import fs from "node:fs";
import path from "node:path";

/**
 * Locates ffmpeg/ffprobe. Order:
 *  1. FFMPEG_PATH / FFPROBE_PATH env vars (absolute exe path)
 *  2. tools/ffmpeg/ next to the app (the bundled copy)
 *  3. system PATH ("ffmpeg" plain — works if user installs it later)
 */
export function findFfmpeg() {
  const toolsDir = path.join(process.cwd(), "tools", "ffmpeg");

  // npm-installed binaries (ffmpeg-static / ffprobe-static), if present
  let pkgFfmpeg = null;
  let pkgFfprobe = null;
  try {
    pkgFfmpeg = require("ffmpeg-static"); // absolute path inside node_modules
  } catch {}
  try {
    pkgFfprobe = require("ffprobe-static").path;
  } catch {}

  const ffmpeg =
    (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH) && process.env.FFMPEG_PATH) ||
    (fs.existsSync(path.join(toolsDir, "ffmpeg.exe")) && path.join(toolsDir, "ffmpeg.exe")) ||
    (fs.existsSync(path.join(toolsDir, "ffmpeg")) && path.join(toolsDir, "ffmpeg")) ||
    (pkgFfmpeg && fs.existsSync(pkgFfmpeg) && pkgFfmpeg) ||
    "ffmpeg";

  const ffprobe =
    (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH) && process.env.FFPROBE_PATH) ||
    (fs.existsSync(path.join(toolsDir, "ffprobe.exe")) && path.join(toolsDir, "ffprobe.exe")) ||
    (fs.existsSync(path.join(toolsDir, "ffprobe")) && fs.existsSync(path.join(toolsDir, "ffprobe")) && path.join(toolsDir, "ffprobe")) ||
    (pkgFfprobe && fs.existsSync(pkgFfprobe) && pkgFfprobe) ||
    "ffprobe";

  return { ffmpeg, ffprobe };
}
