// End-to-end VOD test: pick a movie, build its provider url, pull the first
// 256 KB through the playback proxy, and report.
import { readVod } from "./vod.js";
import { readIptv } from "./iptv.js";

const vod = await readVod();
const iptv = await readIptv();

const all = [...vod.movies].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
// find the first non-adult title to keep test output clean
const m = all.find((x) => !/adult|xxx|18\+|porn/i.test(x.category + " " + x.title)) || all[0];
const s = iptv.sources.find((src) => src.key === m.prov);
console.log("movie:", m.title, `[${m.container}]`, "category:", m.category);

const direct = `${s.host}/movie/${encodeURIComponent(s.username)}/${encodeURIComponent(s.password)}/${m.id}.${m.container}`;
const prox = `http://localhost:3000/api/tv/play?u=${encodeURIComponent(direct)}`;

const t0 = Date.now();
const res = await fetch(prox, { headers: { Range: "bytes=0-262143" } });
const buf = await res.arrayBuffer();
console.log(`proxy: HTTP ${res.status} (${buf.byteLength} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log("content-type:", res.headers.get("content-type"));

// sanity: mp4 should start with ftyp-ish bytes
const magic = [...new Uint8Array(buf.slice(4, 8))].map((b) => String.fromCharCode(b)).join("");
console.log("magic bytes (offset 4):", magic === "ftyp" ? "ftyp ✓" : magic || "(n/a)");
