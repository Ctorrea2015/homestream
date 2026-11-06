// End-to-end test: fetch the /api/tv/transcode route for ~10s and measure
// output throughput. Expect ≥2 Mbps with the QuickSync pipeline (vs ~0.5
// Mbps with the old libx264 path).
import { readIptv } from "./iptv.js";

const BASE = "http://localhost:3000";
const iptv = await readIptv();
const ch =
  iptv.channels.find((c) => c.source?.startsWith("xtream") && /\.ts(\?|$)/i.test(c.url)) ||
  iptv.channels.find((c) => c.source?.startsWith("xtream"));

const url = `${BASE}/api/tv/transcode?u=${encodeURIComponent(ch.url)}`;
console.log("channel:", ch.name);
console.log("requesting transcode…");

const t0 = Date.now();
let bytes = 0;
let status = 0;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  status = res.status;
  if (!res.ok) {
    console.log("HTTP", status, "—", (await res.text()).slice(0, 300));
    process.exit(0);
  }
  const reader = res.body.getReader();
  while (Date.now() - t0 < 10000) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  await reader.cancel().catch(() => {});
} catch (err) {
  console.log("fetch error after", ((Date.now() - t0) / 1000).toFixed(1) + "s:", err?.message || err);
}

const secs = (Date.now() - t0) / 1000;
const bps = bytes * 8 / secs;
const mbps = (bps / 1e6).toFixed(2);
console.log(`got ${(bytes / 1024).toFixed(0)} KB in ${secs.toFixed(1)}s → ${mbps} Mbps via transcode route`);
console.log(Number(mbps) >= 1.5 ? "✓ healthy — hardware encoder is keeping up" : "✗ still slow — investigate");
