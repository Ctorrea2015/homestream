import { NextResponse } from "next/server";
import { readAddons, writeAddons, fetchManifest, catalogUrl, streamUrl } from "@/lib/addons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/addons — installed addons list
export async function GET() {
  return NextResponse.json({ addons: await readAddons() });
}

// POST /api/addons { manifestUrl } — install an addon
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const manifestUrl = String(body?.manifestUrl || "").trim();
  if (!/^https?:\/\//i.test(manifestUrl)) {
    return NextResponse.json({ error: "Paste the addon's manifest.json URL (https://…/manifest.json)" }, { status: 400 });
  }

  let addon;
  try {
    addon = await fetchManifest(manifestUrl);
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 400 });
  }

  const list = await readAddons();
  if (!list.some((a) => a.id === addon.id)) list.push(addon);
  await writeAddons(list);
  return NextResponse.json({
    ok: true,
    addon,
    catalogs: addon.catalogs.map((c) => ({ type: c.type || "movie", id: c.id || "top", name: c.name || c.id || "Catalog" })),
  });
}

// DELETE /api/addons { id } — uninstall
export async function DELETE(request) {
  const body = await request.json().catch(() => ({}));
  if (!body?.id) return NextResponse.json({ error: "Provide addon id" }, { status: 400 });
  const list = await readAddons();
  const kept = list.filter((a) => a.id !== body.id);
  if (kept.length === list.length) return NextResponse.json({ error: "Addon not found" }, { status: 404 });
  await writeAddons(kept);
  return NextResponse.json({ ok: true });
}
