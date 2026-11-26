import fs from "node:fs/promises";
import path from "node:path";
import { FALLBACK_TRACKERS } from "./trackers";

/**
 * librqbit engine (https://github.com/ikatson/rqbit) — a lean Rust torrent
 * daemon with an HTTP API and a native streaming endpoint that supports
 * HTTP Range requests. It is the PRIMARY engine (rqbit → qB → webtorrent);
 * qB is the fallback for swarms rqbit can't resolve.
 *
 * Config (optional): .data/rqbit.json  { "host": "http://127.0.0.1:3030" }
 * No auth by default — rqbit binds to localhost.
 */

let cfg = null;
async function loadCfg() {
  if (cfg !== null) return cfg;
  try {
    cfg = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "rqbit.json"), "utf8"));
  } catch {
    cfg = { host: "http://127.0.0.1:3030" };
  }
  return cfg;
}

/** Riptide (custom engine) host, if configured as the primary engine.
 *  .data/riptide.json: { "enabled": true, "host": "http://127.0.0.1:3031" } */
export async function riptideHost() {
  try {
    const c = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "riptide.json"), "utf8"));
    return c?.enabled && c?.host ? c.host.replace(/\/$/, "") : null;
  } catch { return null; }
}

async function api(host, pathname, init, timeoutMs = 10000) {
  const res = await fetch(`${host}${pathname}`, {
    ...init,
    // Long timeout for magnet ingestion (metadata resolution can block the
    // POST response); aborting early would kill a working registration.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Status first — log truncation cuts the tail, never lose the code.
    throw new Error(`rqbit HTTP ${res.status} ${pathname.split("?")[0]}: ${body.slice(0, 80)}`);
  }
  return res.json();
}

/**
 * Quick single-poll peer count for a loaded torrent. Returns { live, seeders }
 * from the stats endpoint (rqbit/Riptide both expose snapshot.peer_stats).
 * Used by the resolver to skip dead swarms INSTANTLY instead of burning the
 * full byte-wait timeout on each one (2026-11-23: 3 dead sources = ~45s delay).
 */
export async function rqPeerCount(id, hostOverride = null) {
  const host = hostOverride || (await loadCfg()).host;
  try {
    const stats = await api(host, `/torrents/${id}/stats`, {}, 5000);
    const ps = stats?.snapshot?.peer_stats || {};
    return {
      live: Number(ps.live ?? 0),
      seeders: Number(ps.live_seeders ?? 0),
    };
  } catch {
    return { live: -1, seeders: -1 }; // unknown — don't skip based on this
  }
}

/**
 * Wait until the torrent has downloaded its first bytes (or timeout).
 * Needed because rqbit's stream endpoint serves headers immediately even
 * when zero pieces have arrived — a client with an aggressive connect
 * timeout (Debrify's player) sees "connected but no data" and gives up.
 * The webtorrent path has this hold in the stream route; this makes the
 * rqbit path behave the same. Polls the stats endpoint cheaply every second.
 */
export async function rqWaitForData(id, infoHash, maxMs = 60000, hostOverride = null) {
  const host = hostOverride || (await loadCfg()).host;
  const started = Date.now();
  let stats = null;
  while (Date.now() - started < maxMs) {
    try {
      stats = await api(host, `/torrents/${id}/stats`, {}, 5000);
      // rqbit nests the counters: { snapshot: { fetched_bytes,
      // downloaded_and_checked_bytes, ... }, download_speed: {...} }
      const snap = stats?.snapshot || {};
      const bytes = Number(snap.fetched_bytes ?? snap.downloaded_and_checked_bytes ?? 0);
      if (bytes > 0) return true;
    } catch {
      // stats endpoint missing on old rqbit versions — fall back to the list
      try {
        const list = await api(host, "/torrents", {}, 5000);
        const t = (list?.torrents || []).find((x) => String(x.info_hash || "").toLowerCase() === infoHash);
        if (t && Number(t.progress ?? 0) > 0) return true;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false; // timeout — caller proceeds anyway (client may still connect)
}

/**
 * Fast path for metadata: fetch the .torrent BY info hash and POST the bytes.
 * A magnet add blocks until rqbit resolves metadata from DHT/peers — on weak
 * swarms that's 30-60s ("rqbit got the torrent late"). A .torrent carries the
 * metadata already; adding it registers in under a second. Mirrors serve by
 * hash, so the returned bytes must be for the requested infoHash (verified by
 * the caller, which deletes a wrong-hash add).
 *
 * Several independent caches are tried in order — one going down or missing a
 * hash must not cost us the fast path. Returns null when none have it — caller
 * falls back to the magnet path.
 */
const TORRENT_MIRRORS = [
  (h) => `https://itorrents.org/torrent/${h.toLowerCase()}.torrent`,
  (h) => `https://itorrents.net/torrent/${h.toUpperCase()}.torrent`, // .net wants UPPERCASE hex
  (h) => `https://torrage.info/torrent/${h.toLowerCase()}.torrent`,
  (h) => `https://btcache.me/torrent/${h.toLowerCase()}.torrent`,
];

async function torrentBytesFor(infoHash) {
  // Race all mirrors at once: sequential tries cost 4× the timeout (up to 24s
  // on dead mirrors — observed 2026-11-19). Promise.any resolves with the
  // FIRST valid .torrent; all failing/hanging ones are ignored, and if every
  // mirror misses we return null → caller falls back to the magnet path.
  const probes = TORRENT_MIRRORS.map(async (makeUrl) => {
    const res = await fetch(makeUrl(infoHash), {
      headers: { "User-Agent": "HomeStream/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error("mirror HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    // Minimal bencode sanity: a torrent is a dict ('d' … 'e'), not an HTML 404.
    if (buf.length < 100 || buf[0] !== 0x64 || buf[buf.length - 1] !== 0x65) {
      throw new Error("mirror returned non-bencode");
    }
    return buf;
  });
  try {
    return await Promise.any(probes);
  } catch {
    return null; // all mirrors down / missing — magnet fallback
  }
}

const isVideo = (n) => /\.(mp4|mkv|avi|mov|m4v|webm|ts|mpg|wmv|flv)$/i.test(n || "");

/** infoHashes whose only_files selection was already set this server run. */
const rqFocused = new Map(); // infoHash → picked file index (re-applied on change)

export async function rqAvailable() {
  const c = await loadCfg();
  return !!c?.host;
}

/**
 * Ensure the torrent is added and settled, then return the streaming URL
 * for the best video file: { streamUrl, name, size }.
 */
export async function rqEnsureTorrent({ infoHash, nameHint, trackers, host: hostOverride = null }) {
  const c = await loadCfg();
  if (!c?.host && !hostOverride) return null;
  const host = (hostOverride || c.host).replace(/\/$/, "");

  // Already added? (rqbit lists torrents with an id + info_hash)
  let list = await api(host, "/torrents");
  let found = (list?.torrents || []).find(
    (t) => (t.info_hash || t.infoHash || "").toLowerCase() === infoHash.toLowerCase(),
  );

  if (!found) {
    // Official v9 contract (github.com/ikatson/rqbit README): POST the raw
    // magnet URI as the request body; options ride as query params.
    // ("Only_downloads"/JSON shapes were the 400's cause.) Tracker
    // injection: every &tr= rides in the magnet URI itself.
    const trs = [...(trackers || []), ...FALLBACK_TRACKERS].map((t) =>
      `&tr=${encodeURIComponent(t)}`);
    const magnet = `magnet:?xt=urn:btih:${infoHash}${trs.join("")}`;
    const q = new URLSearchParams({ overwrite: "true" });
    // Fast path: POST .torrent bytes (metadata included) instead of a magnet.
    // SKIP for Riptide — it uses qB which resolves magnets from its own session
    // quickly, and the itorrents.org mirror adds 8s of latency on every add.
    // Only worth it for the stock rqbit daemon (weak DHT metadata).
    let added = false;
    const bytes = hostOverride ? null : await torrentBytesFor(infoHash);
    if (bytes) {
      try {
        const info = await api(host, `/torrents?${q}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-bittorrent" },
          body: bytes,
        }, 20000);
        const got = String(info?.details?.info_hash || info?.info_hash || "").toLowerCase();
        if (!got || got === infoHash.toLowerCase()) {
          added = true;
          console.log(`[rqbit] metadata fast path: .torrent added in one shot for ${infoHash.slice(0, 10)}…`);
        } else {
          // Wrong torrent from the mirror — remove it and use the magnet path.
          await fetch(`${host}/torrents/${info?.id}/delete`, { method: "POST", signal: AbortSignal.timeout(10000) }).catch(() => {});
          console.error(`[rqbit] .torrent mirror returned wrong hash ${got.slice(0, 10)} — falling back to magnet`);
        }
      } catch (e) {
        console.error(`[rqbit] .torrent fast path failed (${String(e).slice(0, 70)}) — magnet fallback`);
      }
    }
    if (!added) {
      await api(host, `/torrents?${q}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: magnet,
      }, 30000);
    }
    // The task registers instantly but metadata resolution can take longer;
    // poll /torrents for the info_hash to appear rather than trusting the
    // POST response timing. 60s (not 30): season-pack swarms are often slow
    // to hand over metadata, and an early give-up silently routes shows to
    // the qB fallback instead of rqbit, the primary engine.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      list = await api(host, "/torrents");
      found = (list?.torrents || []).find(
        (t) => (t.info_hash || t.infoHash || "").toLowerCase() === infoHash.toLowerCase(),
      );
      if (found) break;
    }
  }
  if (!found) throw new Error("rqbit could not fetch torrent metadata in time");
  const id = found.id;

  // Resume if the torrent is PAUSED. The janitor pauses rqbit torrents right
  // before deleting them (idle cleanup + the files-vanished ghost rule) — if
  // that delete then fails, a paused zombie stays in the list. We'd find it
  // here, hand the player a stream URL, and NOTHING would ever download:
  // "grabs the torrent but doesn't download it" (2026-11-18, after the user
  // was away >30 min so the idle rule fired). rqbit exposes
  // POST /torrents/{id}/start (resume) but nothing ever called it.
  // Use stats/v1: stats/v0 errors "torrent not live" exactly when paused.
  try {
    let st = await api(host, `/torrents/${infoHash}/stats/v1`, {}, 5000).catch(() => null);
    if (!st) st = await api(host, `/torrents/${infoHash}/stats`, {}, 5000).catch(() => null); // Riptide has no /v1
    const state = String(st?.state || "").toLowerCase();
    const paused = state === "paused" || state === "error" || (state === "initializing" && st?.paused === true);
    if (paused) {
      const res = await fetch(`${host}/torrents/${infoHash}/start`, {
        method: "POST", signal: AbortSignal.timeout(5000),
      });
      console.log(res.ok
        ? `[rqbit] torrent was "${state}" — resumed (id ${id})`
        : `[rqbit] resume of "${state}" torrent failed: HTTP ${res.status}`);
    }
  } catch {} // stats unavailable — skip resume (old behavior)

  // Files: GET /torrents/{id} → details.files[] (name/length varies by version)
  const detail = await api(host, `/torrents/${id}`);
  const files = detail?.files || detail?.details?.files || [];

  /**
   * Same scoring as lib/torrent.js pickVideoFile: in a season pack every
   * episode shares the show name, so only the exact SxxEyy in the hint may
   * decide. (The old check — hint.slice(0, 20) — matched the show name on
   * every sibling and effectively picked a random episode; movies played
   * because single-file torrents always fall through to "biggest".)
   */
  function pickRqFile(list, hint) {
    const videos = [];
    list.forEach((f, i) => {
      const name = f.name || f.file_name || "";
      if (isVideo(name)) videos.push({ i, name, len: Number(f.length ?? f.file_length ?? 0) });
    });
    if (!videos.length) return -1;

    const h = String(hint || "");
    const words = h.toLowerCase().replace(/[^\w]+/g, " ").split(/\s+/).filter((w) => w.length >= 3);
    const hasVideoWord = (s) => /(2160p|1080p|720p|web[\s.-]?dl|blu[\s.-]?ray|remux|x264|x265|hevc|cam|ts)/i.test(s);
    const epMatch = /s(\d{1,2})e(\d{1,3})/i.exec(h);
    const epFileRe = epMatch
      ? new RegExp(`s0*${Number(epMatch[1])}e0*${Number(epMatch[2])}(?:[^\\d]|$)`, "i")
      : null;
    // "1x01" packs (Torrentio's SpongeBob result names files this way) are a
    // third common episode naming — same s/e numbers, different syntax.
    const altEpFileRe = epMatch
      ? new RegExp(`(?:[^\\d]|^)0*${Number(epMatch[1])}x0*${Number(epMatch[2])}(?:[^\\d]|$)`, "i")
      : null;
    // Bare-number packs (very common: "[Anime Time] Dragon Ball Z - 001.mkv")
    // have no SxxEyy anywhere — match the plain episode number at the END of
    // the file's base name. Testing the basename only, and only before the
    // extension, keeps "Season 01" folder names and "Movie 01 - Title.mkv"
    // from falsely matching.
    const baseEpRe = epMatch
      ? new RegExp(`(?:[^0-9]|^)0*${Number(epMatch[2])}\\.(?:mkv|mp4|avi|webm|mov|m4v|ts)`, "i")
      : null;
    const baseOf = (n) => String(n).split(/[\\/]/).pop() || "";

    const scored = videos.map((x) => {
      const fn = x.name.toLowerCase();
      const base = baseOf(x.name);
      let score = words.reduce((acc, w) => acc + (fn.includes(w) ? 1 : 0), 0);
      if (words.length && score > 0 && hasVideoWord(fn)) score += 1;
      const isEpisode = (epFileRe && epFileRe.test(x.name)) || (altEpFileRe && altEpFileRe.test(x.name)) || (baseEpRe && baseEpRe.test(base));
      if (isEpisode) score += 100; // the exact episode wins outright
      if ((epFileRe || altEpFileRe || baseEpRe) && !isEpisode) score = Math.min(score, 3); // demote siblings
      return { ...x, score };
    });

    const best = Math.max(...scored.map((s) => s.score));
    if (best > 0) {
      const top = scored.filter((s) => s.score === best).sort((a, b) => b.len - a.len);
      return top[0].i;
    }
    // no hint / no overlap: prefer real titles over samples/extras
    const sizeable = scored.filter((s) => s.len > 300 * 1024 * 1024);
    if (sizeable.length) return sizeable.sort((a, b) => b.len - a.len)[0].i;
    return scored.sort((a, b) => b.len - a.len)[0].i;
  }

  const pick = pickRqFile(files, nameHint);
  if (pick < 0) throw new Error("no playable video file inside this torrent");

  const name = files[pick]?.name || files[pick]?.file_name || "video";
  const size = Number(files[pick]?.length ?? files[pick]?.file_length ?? 0);

  // Disk-safety guard: refuse a file that can't actually fit. rqbit writes
  // into its output folder — when that filled the disk (the second disk-full
  // incident, 2026-11-14) the torrent couldn't write pieces and rqbit PAUSED
  // it, so the engine sat "not live" forever while playback starved. Check
  // the destination disk and reject monsters outright; the player's candidate
  // cycle moves to the next (ranked, smaller) source instead.
  const outDir = detail?.output_folder || "";
  if (outDir && size > 0) {
    try {
      const st = await fs.statfs(outDir); // Node ≥ 18.15; unsupported → skip
      const free = Number(st.bavail ?? st.b_free) * Number(st.bsize ?? 4096);
      if (free < size + 3 * 1024 * 1024 * 1024) {
        console.error(`[rqbit] DISK GUARD: "${name}" needs ${Math.round(size / 1e9)} GB but only ${Math.round(free / 1e9)} GB free in ${outDir} — deleting torrent ${infoHash}`);
        try { await fetch(`${host}/torrents/${infoHash}/delete`, { method: "POST", signal: AbortSignal.timeout(10000) }); } catch {}
        rqFocused.delete(infoHash);
        throw new Error(`torrent file too big for the disk: ${Math.round(size / 1e9)} GB needed, ${Math.round(free / 1e9)} GB free`);
      }
    } catch (e) {
      if (/too big for the disk/.test(String(e))) throw e; // our own guard — propagate
      // statfs unavailable/failed: proceed without the guard (old behavior)
    }
  }

  // Stream-only focus: by default rqbit downloads EVERY file in the torrent.
  // In a season pack that's the whole season on disk. Tell rqbit to download
  // only the picked file (v9 endpoint, same disk-safety rule as the qB fix).
  // Applied only when the picked file CHANGES — the old guard marked the
  // torrent focused BEFORE the request even ran, so a failed call (rqbit
  // 500s) was never retried: a 319-file DBZ pack downloaded ~370GB with a
  // 7h ETA while the picked episode's pieces were never scheduled, the
  // stream endpoint blocked forever, and playback never started.
  if (files.length > 1 && rqFocused.get(infoHash) !== pick) {
    try {
      const res = await fetch(`${host}/torrents/${infoHash}/update_only_files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ only_files: [pick] }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        rqFocused.set(infoHash, pick); // success only — failures retry on the next ensure
        console.log(`[rqbit] file focus: ${files.length} files → downloading only "${files[pick]?.name || files[pick]?.file_name || "video"}"`);
      } else console.error(`[rqbit] update_only_files HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 100)}`);
    } catch {} // best-effort; retried on the next ensure call until it succeeds
  }

  return {
    // Use the infoHash (STABLE) instead of the numeric id (UNSTABLE): when any
    // torrent is deleted, Riptide/qB renumber the rest, so a cached
    // /torrents/2/stream/0 URL breaks with "no such torrent" — the exact
    // 2026-11-23 Hunger Games bug. Both rqbit and Riptide accept
    // /torrents/{id_or_infohash}/... so the hash works everywhere.
    streamUrl: `${host}/torrents/${infoHash.toLowerCase()}/stream/${pick}`,
    name,
    size,
  };
}
