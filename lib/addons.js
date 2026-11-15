import fs from "node:fs/promises";
import path from "node:path";

const ADDONS_FILE = path.join(process.cwd(), ".data", "addons.json");

export async function readAddons() {
  try {
    const raw = await fs.readFile(ADDONS_FILE, "utf8");
    return JSON.parse(raw); // [{ id, url, name, types, catalogs, desc, addedAt }]
  } catch {
    return [];
  }
}

export async function writeAddons(list) {
  await fs.mkdir(path.dirname(ADDONS_FILE), { recursive: true });
  const tmp = ADDONS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), "utf8");
  await fs.rename(tmp, ADDONS_FILE);
}

/**
 * Fetch and validate a Stremio addon manifest.
 * Keeps the bits HomeStream charms about it; rejects things we can't play or use.
 */
export async function fetchManifest(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "HomeStream/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
  const m = await res.json();
  if (!m?.id || !m?.resources) throw new Error("Not a valid Stremio addon manifest");

  const types = (m.types || []).filter((t) => !/^(all|meta)$/.test(t));
  const catalogs = (m.catalogs || []).filter(
    (c) => !c.type || types.includes(c.type) || types.includes("all")
  );

  return {
    id: m.id,
    url: url.replace(/\/manifest\.json.*$/, ""),
    name: m.name || m.id,
    desc: m.description || "",
    version: m.version || "",
    logo: m.logo || "",
    types,
    catalogs,
    // Genre lists for catalog addons that support genre extras (TMDB etc.)
    genres: Array.isArray(m.genres) ? m.genres : [],
    addedAt: new Date().toISOString(),
  };
}

/**
 * Normalize raw Stremio-addon stream entries into HomeStream's internal
 * stream shape. Torrent infoHash entries become /api/torrent/stream URLs —
 * played by the server's own BitTorrent engine (the Stremio-app pattern).
 * Shared by /api/addons/stream and the Stremio-compatible /stremio surface.
 */
export function normalizeStreams(rawStreams) {
  const streams = [];
  for (const raw of rawStreams || []) {
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
  return streams;
}

/** Build an addon resource URL: <base>/catalog/<type>/<id>.json */
export function catalogUrl(addon, type, catId) {
  return `${addon.url}/catalog/${type}/${catId}.json`;
}

/** <base>/stream/<type>/<id>.json */
export function streamUrl(addon, type, id) {
  return `${addon.url}/stream/${type}/${encodeURIComponent(id)}.json`;
}
