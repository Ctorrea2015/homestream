/**
 * Pi-side VOD conversion diagnostic.
 * Run on the Pi:  node diag-vod.cjs
 *
 * Now also runs the app's own ffmpeg binary directly against the provider
 * file and prints the real error, so no log-hunting is needed.
 */
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

function runs(binary) {
  return new Promise((r) => execFile(binary, ["-version"], { timeout: 10000 }, (e) => r(!e)));
}

function ffTest(ffmpeg, url, ua) {
  return new Promise((resolve) => {
    const args = ["-hide_banner"];
    if (ua) args.push("-user_agent", ua);
    args.push("-i", url, "-t", "5", "-f", "null", "-");
    const p = spawn(ffmpeg, args, { timeout: 30000 });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => resolve({ ok: false, err: e.message }));
    p.on("close", (code) => resolve({ ok: code === 0, err: err.split("\n").filter(Boolean).slice(-4).join(" | ") }));
  });
}

(async () => {
  const iptv = JSON.parse(fs.readFileSync(path.join(__dirname, ".data", "iptv.json"), "utf8"));
  const s = (iptv.sources || []).find((x) => x.kind === "xtream");
  if (!s) { console.log("no xtream source connected"); return; }

  const vod = JSON.parse(fs.readFileSync(path.join(__dirname, ".data", "vod.json"), "utf8"));
  const m = (vod.movies || []).find((x) => x.container === "mkv") || vod.movies[0];
  const url = `${s.host}/movie/${s.username}/${s.password}/${m.id}.${m.container}`;
  console.log("title:", m.title, "| container:", m.container);

  // Part 1: through the app (same as before)
  const base = "http://localhost:3000";
  const t0 = Date.now();
  try {
    const r = await fetch(base + "/api/tv/transcode?u=" + encodeURIComponent(url) + "&f=hls", { redirect: "manual" });
    console.log("app transcode:", r.status, "after", Math.round((Date.now() - t0) / 100) / 10, "s");
    if (r.status !== 302) console.log("app said:", (await r.text()).slice(0, 150));
  } catch (e) { console.log("app unreachable:", String(e).slice(0, 100)); }

  // Part 2: which ffmpeg binaries exist and run
  let bundled = null;
  try { bundled = require(path.join(process.cwd(), "node_modules", "ffmpeg-static")); } catch {}
  const sys = "ffmpeg";
  console.log("bundled ffmpeg:", bundled || "not installed");
  console.log("bundled runs:", bundled ? await runs(bundled) : false, "| system runs:", await runs(sys));

  // Part 3: feed the provider file to each binary directly (the decisive test)
  const UA = "HomeStream/1.0 VLC/3.0";
  for (const [name, ff] of [["bundled", bundled], ["system", sys]]) {
    if (!ff) continue;
    const withUA = await ffTest(ff, url, UA);
    console.log(`${name} + app user-agent: ${withUA.ok ? "READS FINE" : "FAILS"}`);
    if (!withUA.ok) console.log("   error:", withUA.err.slice(0, 250));
    if (!withUA.ok) {
      const noUA = await ffTest(ff, url, null);
      console.log(`${name} default user-agent: ${noUA.ok ? "READS FINE" : "FAILS"}`);
      if (!noUA.ok) console.log("   error:", noUA.err.slice(0, 250));
    }
  }
  process.exit(0);
})().catch((e) => { console.log("ERROR:", String(e).slice(0, 200)); process.exit(0); });
