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
/**
 * GET /api/addons/search?q=Suits[&type=movie|series]
 * Searches every installed addon. When `type` is omitted, BOTH movie and
 * series are searched and merged (so TV shows actually show up when you
 * search their names).
 */
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const q = (p.get("q") || "").trim();
  const type = (p.get("type") || "").replace(/[^a-z]/gi, "");
  if (!q) return NextResponse.json({ metas: [] });
  const wanted = type ? [type] : ["movie", "series"];

  const addons = await readAddons();
  const encoded = encodeURIComponent(q.slice(0, 80));

  const attempts = [];
  for (const t of wanted) {
    const usable = addons.filter((a) => a.types.includes(t) || a.types.includes("all") || a.types.length === 0);
    for (const addon of usable) {
      const cats = (addon.catalogs || []).filter((c) => !c.type || c.type === t);
      const ids = ["search", ...cats.map((c) => c.id || "top")];
      for (const id of ids.slice(0, 3)) attempts.push({ addon, t, id });
    }
  }

  const settled = await Promise.allSettled(
    attempts.map(({ addon, t, id }) =>
      fetch(catalogUrl(addon, t, id, `search=${encoded}`), {
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
        type: m.type || wanted[0],
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
