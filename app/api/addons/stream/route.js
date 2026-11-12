import { NextResponse } from "next/server";
import { readAddons, streamUrl } from "@/lib/addons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/addons/stream?a=<addonId>&type=movie&id=<imdb:tt123>
 * Returns playable options from the addon:
 *  { streams: [{ title, url, quality, size, playable }] }
 * torrent/infoHash streams are routed through the SERVER's torrent engine
 * (/api/torrent/stream) — the same way the Stremio app streams torrents
 * from its own client, no debrid service needed.
 */
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const addonId = p.get("a");
  const type = (p.get("type") || "movie").replace(/[^a-z]/gi, "");
  const id = p.get("id") || "";
  if (!id) return NextResponse.json({ error: "Provide id" }, { status: 400 });

  const addons = await readAddons();
  const addon = addons.find((a) => a.id === addonId);
  if (!addon) return NextResponse.json({ error: "Addon not installed" }, { status: 404 });

  let res;
  try {
    res = await fetch(streamUrl(addon, type, id), {
      headers: { "User-Agent": "HomeStream/1.0" },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    return NextResponse.json({ error: `Addon unreachable: ${err?.message || String(err)}` }, { status: 502 });
  }
  if (!res.ok) return NextResponse.json({ error: `Addon returned HTTP ${res.status}` }, { status: 502 });

  const data = await res.json().catch(() => null);
  const streams = [];
  for (const raw of data?.streams || []) {
    if (raw.url && /^https?:\/\//i.test(raw.url)) {
      streams.push({
        title: raw.title || raw.name || "Stream",
        url: raw.url,
        quality: raw.name && raw.title !== raw.name ? raw.name : (raw.title || "").match(/\d{3,4}[pP]/)?.[0] || "",
        size: raw.behaviorHints?.filename?.match(/\b(\d+(?:\.\d+)?)\s?[GgMm][bB]\b/)?.[0] || "",
        playable: true,
      });
    } else if (raw.infoHash && /^[a-f0-9]{40}$/i.test(raw.infoHash)) {
      // torrent file — played by the server's own BitTorrent engine.
      // Capture the addon's tracker list ("tracker:..." entries in
      // raw.sources) — Stremio injects 20+ so the engine hits them all
      // at once instead of cold-crawling DHT.
      const trackers = (raw.sources || [])
        .filter((s) => typeof s === "string" && s.startsWith("tracker:"))
        .map((s) => s.slice("tracker:".length));
      const trQ = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
      const name = raw.title || raw.name || "";
      streams.push({
        title: name,
        url: `/api/torrent/stream?infoHash=${raw.infoHash.toLowerCase()}&name=${encodeURIComponent(name).slice(0, 300)}${trQ}`,
        quality: raw.name || (name || "").match(/\d{3,4}[pP]/)?.[0] || "",
        size: "",
        playable: true,
        source: "torrent",
      });
    }
  }
  return NextResponse.json({ streams });
}
