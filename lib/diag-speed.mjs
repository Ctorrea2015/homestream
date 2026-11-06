// Measures: (1) raw source throughput of a provider .ts channel,
// (2) ffmpeg QuickSync encode speed on a real live sample.
import { readIptv } from "./iptv.js";

function human(bps) {
  if (bps > 1e6) return (bps / 1e6).toFixed(2) + " Mbps";
  return (bps / 1e3).toFixed(0) + " Kbps";
}

const d = await readIptv();
const ts = d.channels.find((c) => c.source?.startsWith("xtream:") && /\.ts(\?|$)/i.test(c.url));

// --- raw source ---
{
  const t0 = Date.now();
  const res = await fetch(ts.url);
  const reader = res.body.getReader();
  let bytes = 0;
  const budget = 6000;
  while (Date.now() - t0 < budget) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  await reader.cancel().catch(() => {});
  const bps = bytes * 8000 / (Date.now() - t0);
  console.log(`RAW SOURCE (${ts.name}): ${human(bps)} clean — ${bytes > 1e6 ? "provider feed is healthy" : "provider feed is SLOW"}`);
}

// --- QuickSync encode speed, 10s sample of a live .ts ---
const { spawn } = await import("node:child_process");
const ff = process.cwd() + "/tools/ffmpeg/ffmpeg.exe";
const args = [
  "-hide_banner", "-loglevel", "error",
  "-hwaccel", "qsv", "-c:v", "mpeg2video", // try hw decode only if needed; some feeds are h264 → keep generic
  "-i", ts.url,
  "-map", "0:v:0", "-map", "0:a:0?",
  "-c:v", "h264_qsv", "-b:v", "2.5M", "-preset", "veryfast",
  "-c:a", "aac", "-b:a", "128k", "-ac", "2",
  "-t", "10",
  "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1",
];
const child = spawn(ff, ["-hide_banner", "-loglevel", "error", "-i", ts.url,
  "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "h264_qsv", "-b:v", "2.5M",
  "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-t", "10",
  "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"], { windowsHide: true });

let out = 0, err = "", done = false;
child.stdout.on("data", (c) => (out += c.length));
child.stderr.on("data", (c) => (err += c.toString()));
child.on("close", (code) => {
  done = true;
  console.log(`QSV ENCODE: ${code === 0 ? "OK" : "FAILED(code " + code + ")"} — ${(out / 1024).toFixed(0)} KB in 10s → ${human(out * 8 / 10)} out`);
  if (err.trim()) console.log("stderr:", err.trim().slice(-300));
  process.exit(0);
});
setTimeout(() => { if (!done) { console.log("TIMEOUT — killed"); child.kill("SIGKILL"); process.exit(0); } }, 45000);
