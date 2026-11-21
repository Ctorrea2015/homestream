import { NextResponse } from "next/server";
import { corsPreflight } from "@/lib/stremioCors";
import { readAddons, streamUrl, normalizeStreams } from "@/lib/addons";
import { readLibrary } from "@/lib/videos";
import { rankStreams } from "@/lib/rankStreams";
import { showIdFor } from "@/lib/videos";
import { rqEnsureTorrent, riptideHost } from "@/lib/rqbit";
import { touchStream } from "@/lib/idleTorrents";
import { tpbFallbackStreams } from "@/lib/tpb";
import { customEngineStreams } from "@/lib/customEngine";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflight();
}

/** id → { at, list } — 5-min cache of successful addon stream lookups. */
const streamCache = new Map();

/** key → ts — when we last ran the TPB fallback for a title and got nothing. */
const tpbTried = new Map();

/**
 * Scoped pre-fetch: pull the FOCUSED EPISODE (not the season) to disk before
 * the user presses play, by reading rqbit's stream endpoint sequentially —
 * every read is a piece-prioritization hint, so the swarm fills the file
 * front to back while the user browses. Playback then starts off disk and
 * can't be ambushed by weak swarms mid-watch.
 *
 * Bounds (deliberate — this must never become a hoarder):
 *   • one infoHash prefetched at a time (globalThis registry)
 *   • one episode's bytes only (streamUrl is the focused file)
 *   • a CAP on how much is pulled (PREFETCH_CAP_MB) — never the whole season
 *   • the janitor's 30-min idle rule still deletes it untouched
 *   • the stream route's head+tail + warm-up hold keep working for any
 *     episode that isn't prefetched yet (prefetch is best-effort)
 *
 * Speed: larger chunks (16 MB) + 2 reads in flight so the swarm gets ahead
 * of playback quickly. Config via .data/prefetch.json:
 *   { "chunkMB": 16, "parallel": 2, "capMB": 300 }
 */

const PREFETCH_DEFAULTS = { chunkMB: 16, parallel: 2, capMB: 300 };
async function prefetchCfg() {
  try { return { ...PREFETCH_DEFAULTS, ...JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "prefetch.json"), "utf8")) }; }
  catch { return PREFETCH_DEFAULTS; }
}

async function prefetchEpisode(streamUrl, size, infoHash) {
  const g = globalThis;
  if (!g.__hsPrefetching) g.__hsPrefetching = new Set();
  const inflight = g.__hsPrefetching;
  const key = String(infoHash).toLowerCase();
  if (inflight.has(key)) return; // already pulling this torrent
  inflight.add(key);
  const started = Date.now();
  const cfg = await prefetchCfg();
  const chunk = Math.max(1, Number(cfg.chunkMB) || 16) * 1024 * 1024;
  const parallel = Math.max(1, Math.min(6, Number(cfg.parallel) || 2));
  const cap = Math.max(1, Number(cfg.capMB) || 300) * 1024 * 1024;
  const total = Math.min(size, cap); // cap — never pull a whole 100 GB pack
  const ranges = [];
  for (let i = 0; i < total; i += chunk) ranges.push([i, Math.min(i + chunk, total) - 1]);
  console.log(`[prefetch] pulling ${(total / 1048576).toFixed(0)}/${(size / 1048576).toFixed(0)} MB for ${key.slice(0, 10)}… in ${ranges.length} chunks ×${parallel} (cap ${cfg.capMB} MB)`);
  try {
    // Bounded parallel workers: each pulls a distinct range. Range requests
    // through the stream endpoint are idempotent — overlapping pulls are fine
    // and they all drive rqbit/Riptide's piece prioritization.
    let cursor = 0;
    const worker = async () => {
      while (cursor < ranges.length) {
        const [start, end] = ranges[cursor++];
        try {
          const res = await fetch(streamUrl, {
            headers: { "User-Agent": "HomeStream/1.0 VLC/3.0", Range: `bytes=${start}-${end}` },
            signal: AbortSignal.timeout(120_000),
          });
          if (res.ok || res.status === 206) await res.arrayBuffer(); // read through = prioritization hint
        } catch { /* one chunk failed — keep going with the rest */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, ranges.length) }, worker));
    console.log(`[prefetch] ${key.slice(0, 10)}… done in ${Math.round((Date.now() - started) / 1000)}s (${(total / 1048576).toFixed(0)} MB)`);
  } catch {
    console.log(`[prefetch] ${key.slice(0, 10)}… stopped early (best-effort)`);
  } finally {
    inflight.delete(key);
  }
}

/**
 * GET /stremio/stream/{type}/{id}.json
 * Streams for the HomeStream addon, spoken in Stremio dialect:
 *   hs<videoId>            → a library file, served by /api/stream (Range-ready)
 *   hs<showHash>:<s>:<e>   → a library episode
 *   tt…[:s:e]              → every installed torrent addon's sources, ranked
 *                            for this hardware, played by the server's engine
 *                            (/api/torrent/stream). Debrify's libmpv player
 *                            handles mkv/HEVC natively, so the DIRECT stream
 *                            comes first and the Pi's converter isn't needed.
 */
export async function GET(request, { params }) {
  const { type, id: rawId } = await params;
  const id = String(rawId || "").replace(/\.json$/i, "");
  const host = request.headers.get("host");
  if (!host) return NextResponse.json({ streams: [] });
  const base = `http://${host}`;
  const streams = [];

  // ---- library ids ---------------------------------------------------------
  if (id.startsWith("hs")) {
    const lib = await readLibrary();
    const videos = lib.videos || [];
    let video = null;

    if (type === "series") {
      const [showHash, sStr, eStr] = id.split(":");
      const season = parseInt(sStr, 10), episode = parseInt(eStr, 10);
      video = videos.find((v) =>
        (v.kind || "movie") === "episode" &&
        showIdFor(v.show) === showHash &&
        Number(v.season) === season &&
        Number(v.episode) === episode);
    } else {
      video = videos.find((v) => "hs" + v.id === id) || null;
    }

    if (video) {
      streams.push({
        title: "HomeStream library",
        url: `${base}/api/stream?id=${encodeURIComponent(video.id)}`,
        behaviorHints: { notWebReady: true },
      });
    }
    return NextResponse.json({ streams, cacheMaxAge: 0 });
  }

  // ---- tt ids: ranked torrent sources through the server's engine ----------
  const torrentId = type === "series" && id.includes(":") ? id : id; // addons want the :s:e form for series
  // Cache successful addon answers for 5 min: Torrentio can take 10-25 s and
  // rate-limits aggressively — clients (Debrify) time out and report "no
  // playable source" while the server was still waiting. Repeat taps and
  // client retries now get the instant cached list instead.
  const cacheKey = `${type}|${torrentId}`;
  const now = Date.now();
  const hit = streamCache.get(cacheKey);
  let all;
  if (hit && now - hit.at < 5 * 60 * 1000) {
    all = hit.list;
  } else {
    const addons = (await readAddons()).filter(
      (a) => (a.types || []).includes(type) || (a.types || []).includes("all")
    );
    const results = await Promise.allSettled(
      addons.map(async (a) => {
        const res = await fetch(streamUrl(a, type, torrentId), {
          headers: { "User-Agent": "HomeStream/1.0" },
          signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) return [];
        const data = await res.json().catch(() => null);
        return normalizeStreams(data?.streams);
      })
    );
    all = [];
    for (const r of results) if (r.status === "fulfilled") all.push(...r.value);
    if (all.length) streamCache.set(cacheKey, { at: now, list: all });
  }

  // ---- External custom engine (HTTP service — see CUSTOM-ENGINE-API.md) ---
  // Its sources go through the same ranker / pre-warm / rqbit play chain.
  {
    const ep = type === "series" ? /:(\d{1,2}):(\d{1,3})$/.exec(torrentId) : null;
    const custom = await customEngineStreams({
      type,
      id: torrentId,
      season: ep ? Number(ep[1]) : undefined,
      episode: ep ? Number(ep[2]) : undefined,
    });
    if (custom.length) all.push(...custom);
  }

  // ---- TPB fallback: Torrentio sometimes drops whole shows ---------------
  // 2026-11-18: Arthur / SpongeBob / Fear Factor suddenly had ZERO sources on
  // Torrentio while the packs were alive on TPB at 50+ seeders. When no addon
  // yields torrent sources, search apibay ourselves and append streams that
  // rank and pre-warm like any other torrent source. A short negative-cache
  // keeps a truly-absent title from re-hitting apibay on every request.
  if (!all.some((s) => s.source === "torrent")) {
    const fbKey = `${type}|${torrentId}`;
    const lastTry = tpbTried.get(fbKey) || 0;
    if (Date.now() - lastTry > 2 * 60 * 1000) {
      tpbTried.set(fbKey, Date.now());
      try {
        const m = /^(tt\d+)(?::(\d{1,2}):(\d{1,3}))?$/.exec(torrentId);
        const fb = await tpbFallbackStreams({
          type,
          ttId: m?.[1] || torrentId,
          season: m?.[2] ? Number(m[2]) : undefined,
          episode: m?.[3] ? Number(m[3]) : undefined,
          base,
        });
        if (fb.length) {
          all.push(...fb.map((s) => ({ ...s, title: `📡 ${s.title}` })));
          tpbTried.delete(fbKey); // worked — allow again immediately next time
          console.log(`[stremio] addons came up empty for ${torrentId} — TPB fallback added ${fb.length} sources`);
        }
      } catch {}
    }
  }

  // Ranked for the Pi + client (1080p/x264/seeders first), then made absolute
  // so Debrify — wherever it runs — reaches the SERVER, not itself.
  // For series, append the requested SxxEyy to the name hint: the addon's
  // pack title ("Rules of Engagement Season 1 Complete") carries NO episode
  // marker, so the engine's episode picker had nothing to match and grabbed
  // the pack's biggest file instead of the requested episode.
  const epM = type === "series" ? /:(\d{1,2}):(\d{1,3})$/.exec(id) : null;
  const epTag = epM ? ` S${String(Number(epM[1])).padStart(2, "0")}E${String(Number(epM[2])).padStart(2, "0")}` : "";
  const ranked = rankStreams(all).slice(0, 12);

  // ---- ⚡ Auto: one tap to the top-ranked raw torrent, already on rqbit ---
  // Debrify/libmpv follows the 302 from the play route straight into the
  // stream endpoint. The normal pre-warm below has usually loaded the same
  // torrent by the time the user taps, so the resolve inside is instant.
  if (ranked.some((s) => s.source === "torrent")) {
    const auto = new URL("/api/torrent/resolve/play", base);
    auto.searchParams.set("id", torrentId);
    auto.searchParams.set("type", type);
    streams.push({
      title: "⚡ Auto — best source, already pre-warmed",
      url: auto.toString(),
      behaviorHints: { notWebReady: true },
    });
  }

  // Pre-warm the best torrent source: register it with rqbit NOW, in the
  // background, so the swarm wakes up while the user is still looking at the
  // source list. Direct clients (Debrify) have aggressive connect timeouts —
  // a play request that starts cold loses the race; one that starts warm
  // streams immediately. The janitor still cleans it if never played.
  try {
    const best = ranked.find((s) => s.source === "torrent");
    if (best) {
      const abs0 = new URL(best.url, base);
      if (abs0.pathname === "/api/torrent/stream") {
        const h = abs0.searchParams.get("infoHash");
        const hint = (abs0.searchParams.get("name") || "") + epTag;
        const trs = abs0.searchParams.getAll("tr");
        if (h && /^[a-f0-9]{40}$/i.test(h)) {
          h = h.toLowerCase();
          // Mark liveness NOW: all episodes of a season often share ONE pack
          // infoHash — without a fresh touch, the janitor judges it idle from
          // the PREVIOUS episode's timestamp and deletes it minutes after
          // pre-warm (the Fear Factor ep3 kill, 2026-11-16).
          touchStream(h);
          // Pre-warm on the PRIMARY engine (Riptide when configured, rqbit
          // otherwise) — otherwise the prefetch warms rqbit while playback
          // uses Riptide, wasting the whole effort. Falls back if needed.
          (async () => {
            const host = await riptideHost();
            try {
              const r = await rqEnsureTorrent({ infoHash: h, nameHint: hint, trackers: trs, host });
              if (r?.streamUrl && r?.size) return r;
            } catch {}
            if (host) { // Riptide failed — try the stock rqbit daemon
              try {
                const r = await rqEnsureTorrent({ infoHash: h, nameHint: hint, trackers: trs });
                if (r?.streamUrl && r?.size) return r;
              } catch {}
            }
            return null;
          })()
            .then((r) => { if (r) prefetchEpisode(r.streamUrl, r.size, h); })
            .catch(() => {}); // fire-and-forget
          console.log(`[stremio] pre-warming best torrent source ${h.slice(0, 10)}… on ${(await riptideHost()) ? "Riptide" : "rqbit"}`);
        }
      }
    }
  } catch {}

  for (const s of ranked) {
    try {
      const abs = new URL(s.url, base);
      if (epTag && s.source === "torrent" && abs.pathname === "/api/torrent/stream") {
        const q = abs.searchParams;
        q.set("name", (q.get("name") || "") + epTag);
        abs.search = q.toString();
      }
      streams.push({
        title: (s.source === "torrent" ? "🎬 " : "") + s.title,
        url: abs.toString(),
        behaviorHints: { notWebReady: true },
      });
    } catch {}
  }
  // One converted fallback (browser-safe HLS) for the best source, in case
  // the client's player chokes on something exotic (Dolby Vision etc.).
  if (ranked[0]) {
    try {
      const abs = new URL(ranked[0].url, base);
      streams.push({
        title: "⚙️ Converted (browser-safe) — same source",
        url: `${base}/api/tv/transcode?u=${encodeURIComponent(abs.pathname + abs.search)}&f=hls&vod=1`,
        behaviorHints: { notWebReady: true },
      });
    } catch {}
  }

  return NextResponse.json({ streams, cacheMaxAge: 0 });
}
