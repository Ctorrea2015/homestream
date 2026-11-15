import { NextResponse } from "next/server";
import { readAddons, streamUrl, normalizeStreams } from "@/lib/addons";
import { readLibrary } from "@/lib/videos";
import { rankStreams } from "@/lib/rankStreams";
import { showIdFor } from "@/lib/videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const all = [];
  for (const r of results) if (r.status === "fulfilled") all.push(...r.value);

  // Ranked for the Pi + client (1080p/x264/seeders first), then made absolute
  // so Debrify — wherever it runs — reaches the SERVER, not itself.
  const ranked = rankStreams(all).slice(0, 12);
  for (const s of ranked) {
    try {
      const abs = new URL(s.url, base);
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
