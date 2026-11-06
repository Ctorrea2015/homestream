// End-to-end test of the new HLS restream:
// 1. GET /api/tv/transcode?u=<provider .ts>&f=hls → expect 302 to /api/tv/hls/<id>/index.m3u8
// 2. Fetch the playlist → expect a live #EXTM3U with segments
// 3. Fetch one segment → expect mpegts bytes
// 4. Re-fetch the playlist after a few seconds → window should have advanced
import { readIptv } from "./iptv.js";

const BASE = "http://localhost:3000";
const iptv = await readIptv();
const ch = iptv.channels.find((c) => c.source?.startsWith("xtream") && /\.ts(\?|$)/i.test(c.url));
console.log("channel:", ch.name);

const t0 = Date.now();
const first = await fetch(`${BASE}/api/tv/transcode?u=${encodeURIComponent(ch.url)}&f=hls`, { redirect: "manual" });
console.log(`step1: HTTP ${first.status} → ${first.headers.get("location") || "(no redirect)"}`);
if (first.status !== 302) {
  console.log("body:", (await first.text()).slice(0, 300));
  process.exit(0);
}
const playlistUrl = new URL(first.headers.get("location"), BASE).href;

const pl = await fetch(playlistUrl);
const plText = await pl.text();
console.log("step2: HTTP", pl.status, "| content-type:", pl.headers.get("content-type"));
console.log(plText.slice(0, 400));

const segs = [...plText.matchAll(/^([^\s#]+)$/gm)].map((m) => m[1]).filter((s) => /\.(ts|mp4)$/i.test(s));
if (segs.length === 0) { console.log("no segments in playlist"); process.exit(0); }
const segUrl = new URL(segs[segs.length - 1], playlistUrl).href;
const seg = await fetch(segUrl);
const segBuf = await seg.arrayBuffer();
const head = new Uint8Array(segBuf.slice(0, 4));
console.log(`step3: segment ${segs[segs.length - 1]} → HTTP ${seg.status}, ${(segBuf.byteLength / 1024).toFixed(0)} KB, magic bytes: ${[...head].map((b) => b.toString(16).padStart(2, "0")).join(" ")} (47 = MPEG-TS ✓)`);

// 4: does the window advance? (segments are GOP-sized, ~8.5s — wait long enough)
await new Promise((r) => setTimeout(r, 20000));
const pl2 = await fetch(playlistUrl);
const pl2Text = await pl2.text();
const advanced = pl2Text !== plText;
const seq = [...pl2Text.matchAll(/#EXT-X-MEDIA-SEQUENCE:(\d+)/g)][0]?.[1];
console.log("step4: playlist advanced over time:", advanced ? `✓ live (media sequence now ${seq})` : "✗ static");
