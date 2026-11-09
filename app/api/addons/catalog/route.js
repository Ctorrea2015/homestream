import { NextResponse } from "next/server";
import { readAddons, catalogUrl } from "@/lib/addons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/addons/catalog?a=<addonId>&type=movie&cat=top&page=1
 * Proxies the addon's catalog JSON and returns normalized metas:
 * { id, type, name, poster, year, rating, description }.
 */
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const addonId = p.get("a");
  const type = (p.get("type") || "movie").replace(/[^a-z]/gi, "");
  const cat = (p.get("cat") || "top").replace(/[^a-z0-9_.-]/gi, ""); // keep dots — addon catalog ids like "tmdb.top"

  const addons = await readAddons();
  const addon = addons.find((a) => a.id === addonId);
  if (!addon) return NextResponse.json({ error: "Addon not installed" }, { status: 404 });

  // Page step = the addon's declared page size when it provides one
  // (TMDB addon pages 20 at a time; Cinemeta does 100).
  const catDef = (addon.catalogs || []).find(
    (c) => (c.type || "movie") === type && String(c.id || "top") === cat,
  );
  const pageSize = Number(catDef?.pageSize) > 0 ? Number(catDef.pageSize) : 100;
  const skip = Math.max(0, (Math.max(1, Number(p.get("page") || 1)) - 1)) * pageSize;

  // Stremio extra format is path-based: /catalog/<type>/<id>/skip=20.json
  // (query-string `?skip=` is not supported by many addon back-ends)
  const base = catalogUrl(addon, type, cat).replace(/\.json$/, "");
  const url = `${base}${skip > 0 ? `/skip=${skip}` : ""}.json`;

  // Free-hosted addons (baby-beamup / Render / Replit …) sleep when idle and
  // answer the waking request with 503/504. Retry a couple of times with a
  // pause so a cold start feels like a normal click instead of an error.
  let res = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "HomeStream/1.0" }, signal: AbortSignal.timeout(25000) });
      if (r.ok) { res = r; break; }
      lastErr = `HTTP ${r.status}`;
      if (r.status !== 502 && r.status !== 503 && r.status !== 504) { res = r; break; } // 4xx won't fix itself — stop
    } catch (err) {
      lastErr = err?.message || String(err);
      if (attempt < 3) await new Promise((r2) => setTimeout(r2, 5000));
    }
    if (attempt < 3) await new Promise((r2) => setTimeout(r2, 5000));
  }
  if (!res || !res.ok) {
    return NextResponse.json(
      { error: `Catalog unreachable after retries (${lastErr}) — the addon's server may be waking up; try again in a moment.` },
      { status: 502 },
    );
  }

  const data = await res.json().catch(() => null);
  const metas = (data?.metas || []).map((m) => ({
    id: String(m.id),
    type: m.type || type,
    name: m.name || m.title || "",
    poster: m.poster || "",
    year: m.releaseInfo ? String(m.releaseInfo).match(/\d{4}/)?.[0] : m.year ? String(m.year) : "",
    rating: m.imdbRating || m.rating || null,
    description: m.description || "",
  }));

  return NextResponse.json({ metas });
}
