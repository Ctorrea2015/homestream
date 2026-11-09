import { NextResponse } from "next/server";
import { readAddons } from "@/lib/addons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/addons/meta?a=<addonId>&type=series&id=tt0108778
 * Proxy for an addon's meta resource. Used by the Addons page to fetch the
 * episode list of a series (meta.videos), which is needed to pick a specific
 * episode before requesting streams — torrents are keyed per-episode
 * (tt0108778:1:2), not per-show.
 */
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const addonId = p.get("a");
  const type = (p.get("type") || "series").replace(/[^a-z]/gi, "");
  const id = p.get("id") || "";
  if (!id) return NextResponse.json({ error: "Provide id" }, { status: 400 });

  const addons = await readAddons();
  const addon = addons.find((a) => a.id === addonId);
  if (!addon) return NextResponse.json({ error: "Addon not installed" }, { status: 404 });

  let res;
  try {
    res = await fetch(`${addon.url}/meta/${type}/${encodeURIComponent(id)}.json`, {
      headers: { "User-Agent": "HomeStream/1.0" },
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    return NextResponse.json({ error: `Addon unreachable: ${err?.message || String(err)}` }, { status: 502 });
  }
  if (!res.ok) return NextResponse.json({ error: `Addon returned HTTP ${res.status}` }, { status: 502 });

  const data = await res.json().catch(() => null);
  if (!data?.meta) return NextResponse.json({ error: "No meta returned" }, { status: 404 });
  return NextResponse.json(data);
}
