/**
 * Custom engine — standalone HTTP service for HomeStream.
 * No npm dependencies. Run: node custom-engine/server.mjs  (PORT env optional)
 *
 * Implements the spec:
 *  • multi-source: Torrentio + apibay (add Jackett/Prowlarr by adding fetchers)
 *  • health gate: drops 0-seeder releases, verifies real seeder counts
 *  • ranking: seeders + resolution + codec (H.264/AAC MP4/MKV first for iOS)
 *  • trackers: appends a list of known-healthy public UDP/HTTP trackers
 *
 * Contract: POST /streams  { type, id, title, season, episode }
 *        → { provider, streams: [{ infoHash, title, seeders, size, trackers }] }
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 4000);
const CFG = JSON.parse(await (await import("node:fs/promises")).readFile(
  new URL("./config.json", import.meta.url), "utf8").catch(() => "{}"));

const TRACKERS = CFG.trackers || [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "http://tracker.openbittorrent.com:80/announce",
];

async function get(url, ms = 12000) {
  const r = await fetch(url, {
    headers: { "User-Agent": "HomeStream-CustomEngine/1.0" },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

/** Torrentio — returns magnet/infoHash streams keyed by IMDb id. */
async function fromTorrentio(type, id) {
  if (!CFG.torrentioUrl) return [];
  const data = await get(`${CFG.torrentioUrl}/stream/${type}/${encodeURIComponent(id)}.json`);
  return (data?.streams || [])
    .filter((s) => /^[a-f0-9]{40}$/i.test(s.infoHash || ""))
    .map((s) => ({
      infoHash: s.infoHash.toLowerCase(),
      title: s.title || "",
      seeders: Number((s.title || "").match(/👤\s*(\d+)/)?.[1] ?? 0), // addon badge
      sources: s.sources || [],
    }));
}

/** apibay (TPB API) — real seeder counts; query by title words from IMDb id
 *  is not possible, so this is seeded by the title when the client provides one. */
async function fromApibay(title, type) {
  if (!title) return [];
  const q = encodeURIComponent(title.toLowerCase());
  const cat = type === "series" ? "&cat=205" : "";
  const rows = await get(`https://apibay.org/q.php?q=${q}${cat}`);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => /^[a-f0-9]{40}$/i.test(r.info_hash || "") && Number(r.seeders) > 0)
    .map((r) => ({ infoHash: r.info_hash.toLowerCase(), title: String(r.name || ""),
      seeders: Number(r.seeders), size: Number(r.size) || 0, realSeeders: true }));
}

/** Health gatekeeper + ranker. */
function gateAndRank(streams) {
  const seen = new Set();
  const scored = [];
  for (const s of streams) {
    if (seen.has(s.infoHash)) continue;
    seen.add(s.infoHash);
    if (!(s.seeders > 0)) continue; // 0 seeders → dead release, drop
    const t = s.title.toLowerCase();
    let score = Math.min(s.seeders, 100) * 0.8;
    if (/1080p/.test(t)) score += 30;
    else if (/720p/.test(t)) score += 18;
    if (/x264|h\.?264|avc/.test(t)) score += 20;
    if (/\bhevc\b|x265/.test(t)) score += 8;
    if (/\.mp4\b|\.mkv\b|mp4|mkv/.test(t)) score += 10; // native iOS decode
    if (/aac|ac3/.test(t)) score += 5;
    if (/2160p|4k|remux|dolby vision|av1/.test(t)) score -= 40;
    if (/yify|yts\b/.test(t)) score -= 15;
    score += s.realSeeders ? 10 : 0; // verified counts beat cached badges
    scored.push({ ...s, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 12);
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
  };
  if (req.url === "/health") return send(200, { ok: true, provider: "custom-engine" });
  if (req.url !== "/streams" || req.method !== "POST") return send(404, { error: "POST /streams" });
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const p = JSON.parse(body || "{}");
    if (!/^(movie|series)$/.test(p.type || "") || !/^tt\d+(:\d+:\d+)?$/.test(p.id || "")) {
      return send(400, { error: "Need type=movie|series and id=tt…" });
    }
    const tt = String(p.id).split(":")[0];
    const [a, b] = await Promise.allSettled([
      fromTorrentio(p.type, p.id),
      fromApibay(p.title, p.type),
    ]);
    const all = [
      ...(a.status === "fulfilled" ? a.value : []),
      ...(b.status === "fulfilled" ? b.value : []),
    ];
    const streams = gateAndRank(all).map((s) => ({
      infoHash: s.infoHash,
      title: s.title,
      seeders: s.seeders,
      size: s.size || 0,
      trackers: [...new Set([...(s.sources || []).filter((x) => x.startsWith("tracker:")).map((x) => x.slice(8)), ...TRACKERS])],
    }));
    return send(200, { provider: "custom-engine", streams });
  } catch (e) {
    return send(500, { error: String(e).slice(0, 120) });
  }
});

server.listen(PORT, () => console.log(`Custom engine listening on http://127.0.0.1:${PORT}/streams`));
