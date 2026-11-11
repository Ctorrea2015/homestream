/**
 * Pi-side VOD conversion diagnostic.
 * Run on the Pi:  node diag-vod.cjs
 * Measures how long the server takes to produce the first playable piece
 * for a real provider movie — the number that decides if iPhones work.
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const iptv = JSON.parse(fs.readFileSync(path.join(__dirname, ".data", "iptv.json"), "utf8"));
  const s = (iptv.sources || []).find((x) => x.kind === "xtream");
  if (!s) { console.log("no xtream source connected"); return; }

  const vod = JSON.parse(fs.readFileSync(path.join(__dirname, ".data", "vod.json"), "utf8"));
  const m = (vod.movies || []).find((x) => x.container === "mkv") || vod.movies[0];
  const url = `${s.host}/movie/${s.username}/${s.password}/${m.id}.${m.container}`;
  console.log("title:", m.title, "| container:", m.container);

  const base = "http://localhost:3000";
  const t0 = Date.now();
  const r = await fetch(base + "/api/tv/transcode?u=" + encodeURIComponent(url) + "&f=hls", { redirect: "manual" });
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  console.log("first playlist:", r.status, "after", secs, "s");

  if (r.status !== 302) {
    console.log("body:", (await r.text()).slice(0, 200));
  } else {
    const loc = r.headers.get("location");
    const pl = await (await fetch(loc)).text();
    const seg = /s\d{5}\.ts/.exec(pl);
    if (!seg) { console.log("playlist has no segments:\n" + pl.slice(0, 300)); }
    else {
      const t1 = Date.now();
      const sg = await fetch(new URL(seg[0], loc));
      const b = await sg.arrayBuffer();
      console.log("first segment:", sg.status, Math.round(b.byteLength / 1024) + " KB in", Math.round((Date.now() - t1) / 100) / 10, "s");
      console.log(b.byteLength > 100000 ? "RESULT: conversion WORKS on this machine" : "RESULT: segment suspiciously small");
    }
  }
  console.log("pi cpu cores:", require("os").cpus().length, "| model:", require("os").cpus()[0].model.trim());
  process.exit(0);
})().catch((e) => { console.log("ERROR:", String(e).slice(0, 200)); process.exit(0); });
