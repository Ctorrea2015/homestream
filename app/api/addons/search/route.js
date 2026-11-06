import { NextResponse } from "next/server";
import { readAddons } from "@/lib/addons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stremio extra-args go before ".json": /catalog/movie/top/search=batman.json */
function catalogUrl(addon, type, catId, extras = "") {
  const base = `${addon.url}/catalog/${type}/${encodeURIComponent(catId)}`;
  return extras ? `${base}/${extras}.json` : `${base}.json`;
}

/**
 * GET /api/addons/search?q=batman&type=movie
 * Searches every installed addon (those that offer that type) and returns
 * a merged poster list, newest addons first. Addons that don't support
 * search are skipped silently.
 */
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const q = (p.get("q") || "").trim();
  const type = (p.get("type") || "movie").replace(/[^a-z]/gi, "");
  if (!q) return NextResponse.json({ metas: [] });

  const addons = await readAddons();
  const usable = addons.filter((a) => a.types.includes(type) || a.types.includes("all") || a.types.length === 0);

  const encoded = encodeURIComponent(q.slice(0, 80));
  const attempts = usable.flatMap((addon) => {
    const cats = (addon.catalogs || []).filter((c) => !c.type || c.type === type);
    const ids = ["search", ...cats.map((c) => c.id || "top")];
    return ids.slice(0, 3).map((id) => ({ addon, id: id }));
  });

  const settled = await Promise.allSettled(
    attempts.map(({ addon, id }) =>
      fetch(catalogUrl(addon, type, id, `search=${encoded}`), {
        headers: { "User-Agent": "HomeStream/1.0" },
        signal: AbortSignal.timeout(20000),
      }).then((r) => (r.ok ? r.json() : null))
    )
  );

  const seen = new Set();
  const metas = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value?.metas) continue;
    for (const m of s.value.metas) {
      const key = `${m.id}|${m.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      metas.push({
        id: String(m.id),
        type: m.type || type,
        name: m.name || "",
        poster: m.poster || "",
        year: m.releaseInfo ? String(m.releaseInfo).match(/\d{4}/)?.[0] : "",
        rating: m.imdbRating || m.rating || null,
        description: m.description || "",
      });
      if (metas.length >= 120) break;
    }
    if (metas.length >= 120) break;
  }

  return NextResponse.json({ metas });
}
