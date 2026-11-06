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
  const cat = (p.get("cat") || "top").replace(/[^a-z0-9_-]/gi, "");
  const skip = Math.max(0, Number(p.get("page") || 1) - 1) * 100;

  const addons = await readAddons();
  const addon = addons.find((a) => a.id === addonId);
  if (!addon) return NextResponse.json({ error: "Addon not installed" }, { status: 404 });

  const url = `${catalogUrl(addon, type, cat)}/extra=${skip <= 0 ? "" : `skip=${skip}`}`.replace("/extra=", "");
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "HomeStream/1.0" }, signal: AbortSignal.timeout(25000) });
  } catch (err) {
    return NextResponse.json({ error: `Catalog unreachable: ${err?.message || String(err)}` }, { status: 502 });
  }
  if (!res.ok) return NextResponse.json({ error: `Addon returned HTTP ${res.status}` }, { status: 502 });

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
