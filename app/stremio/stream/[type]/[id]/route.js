import { NextResponse } from "next/server";
import { corsPreflight } from "@/lib/stremioCors";
import { readAddons, streamUrl, normalizeStreams } from "@/lib/addons";
import { readLibrary } from "@/lib/videos";
import { rankStreams } from "@/lib/rankStreams";
import { showIdFor } from "@/lib/videos";
import { rqEnsureTorrent } from "@/lib/rqbit";
import { touchStream } from "@/lib/idleTorrents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflight();
}

/** id → { at, list } — 5-min cache of successful addon stream lookups. */
const streamCache = new Map();

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

  // Ranked for the Pi + client (1080p/x264/seeders first), then made absolute
  // so Debrify — wherever it runs — reaches the SERVER, not itself.
  // For series, append the requested SxxEyy to the name hint: the addon's
  // pack title ("Rules of Engagement Season 1 Complete") carries NO episode
  // marker, so the engine's episode picker had nothing to match and grabbed
  // the pack's biggest file instead of the requested episode.
  const epM = type === "series" ? /:(\d{1,2}):(\d{1,3})$/.exec(id) : null;
  const epTag = epM ? ` S${String(Number(epM[1])).padStart(2, "0")}E${String(Number(epM[2])).padStart(2, "0")}` : "";
  const ranked = rankStreams(all).slice(0, 12);

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
          rqEnsureTorrent({ infoHash: h, nameHint: hint, trackers: trs })
            .catch(() => {})
            .finally(() => {}); // fire-and-forget
          console.log(`[stremio] pre-warming best torrent source ${h.slice(0, 10)}… (${(best.title || "").slice(0, 60)})`);
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
