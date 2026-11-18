/**
 * TPB fallback provider — rescues titles Torrentio's scrapers have dropped.
 *
 * Why: 2026-11-18, Torrentio suddenly returned ZERO sources for several
 * series that were playable days earlier (Arthur, SpongeBob, Fear Factor)
 * while movies kept hundreds of sources. The torrents themselves were alive
 * — TPB's API still showed "Arthur 1996 Seasons 01-05 Complete" at 53
 * seeders. When every addon comes back empty, we search apibay ourselves
 * and hand the same synthetic torrent streams to the ranker.
 *
 * Source: apibay.org — ThePirateBay's official read-only JSON API. No auth,
 * no Cloudflare, returns { name, info_hash, seeders, leechers, size, category }.
 * Torrentio scrapes TPB too, so this only ever ADDS listings, never conflicts.
 */

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://open.stealth.si:80/announce",
];

/** tt-id → { name, at } — Cinemeta title cache (24 h TTL). */
const metaCache = new Map();
const META_TTL = 24 * 60 * 60 * 1000;
// cinemeta-live is canonical; v3 307-redirects there but is intermittently
// empty, so try both and take the first name.
const CINEMETA_HOSTS = ["https://cinemeta-live.strem.io", "https://v3-cinemeta.strem.io"];

async function titleFor(type, ttId) {
  const key = `${type}|${ttId}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL) return hit.name;
  for (const host of CINEMETA_HOSTS) {
    try {
      const res = await fetch(`${host}/meta/${type}/${ttId}.json`, {
        headers: { "User-Agent": "HomeStream/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const name = data?.meta?.name;
      if (!name) continue;
      metaCache.set(key, { at: Date.now(), name });
      return name;
    } catch {}
  }
  throw new Error("cinemeta: no name");
}

/**
 * Search apibay. Only results whose release name contains EVERY word of the
 * show/movie title are kept (bare "arthur" would otherwise match "Count
 * Arthur Strong" — the episode picker at play time is the final filter, but
 * the list should be honest).
 */
async function apibay(query, cat) {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}${cat ? `&cat=${cat}` : ""}`;
  const res = await fetch(url, { headers: { "User-Agent": "HomeStream/1.0" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) ? rows.filter((r) => r && /^[a-f0-9]{40}$/i.test(r.info_hash || "")) : [];
}

/**
 * Build synthetic torrent streams for the fallback.
 * Returns [] on any failure — the fallback must never break the normal path.
 */
export async function tpbFallbackStreams({ type, ttId, season, episode, base, limit = 8 }) {
  try {
    const title = await titleFor(type, ttId);
    const words = String(title).toLowerCase().match(/[a-z0-9]+/g) || [];
    if (!words.length) return [];

    const S = String(season || 0).padStart(2, "0");
    const E = String(episode || 0).padStart(2, "0");
    // apibay is CASE-SENSITIVE ("titanic" → 100 hits, "Titanic" → 0).
    const tLc = title.toLowerCase();
    // Series: episode query first, then season-pack queries — a 53-seeder
    // complete pack beats a 1-seeder single episode every time.
    const queries =
      type === "series" && season && episode
        ? [`${tLc} s${S}e${E}`, `${tLc} season ${season}`, `${tLc} complete`]
        : type === "series"
          ? [tLc]
          : [tLc];
    const cat = type === "series" ? 205 : undefined; // TPB video/TV category

    const rows = [];
    const seen = new Set();
    for (const q of queries) {
      for (const r of await apibay(q, cat)) {
        const h = r.info_hash.toLowerCase();
        if (seen.has(h)) continue;
        const name = String(r.name || "");
        const low = name.toLowerCase();
        if (!words.every((w) => low.includes(w))) continue;
        seen.add(h);
        rows.push(r);
      }
      if (rows.length >= limit * 4) break; // enough candidates
    }

    // Seeders first: a 53-seeder complete pack must beat a 1-seeder single
    // episode — the pack is also what survives "Torrentio dropped the listing"
    // days (single-episode listings vanish with their indexers, packs don't).
    rows.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

    return rows.slice(0, limit).map((r) => {
      const gb = Number(r.size) / 1073741824;
      const badges = ` 👥${r.seeders ?? 0}${gb > 0.05 ? ` 💾${gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`}` : ""}`;
      const trs = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
      return {
        title: `${r.name}${badges}`,
        source: "torrent",
        infoHash: r.info_hash.toLowerCase(),
        url: `${base}/api/torrent/stream?infoHash=${r.info_hash.toLowerCase()}&name=${encodeURIComponent(r.name)}${trs}`,
        behaviorHints: { notWebReady: true },
      };
    });
  } catch (e) {
    console.error("[tpb-fallback] failed:", String(e).slice(0, 100));
    return [];
  }
}
