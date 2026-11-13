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

/** Build an addon resource URL: <base>/catalog/<type>/<id>.json */
export function catalogUrl(addon, type, catId) {
  return `${addon.url}/catalog/${type}/${catId}.json`;
}

/** <base>/stream/<type>/<id>.json */
export function streamUrl(addon, type, id) {
  return `${addon.url}/stream/${type}/${encodeURIComponent(id)}.json`;
}
