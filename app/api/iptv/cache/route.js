import { NextResponse } from "next/server";
import { dbStatus, listCategories, listChannels, syncAll } from "@/lib/iptvHandler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/iptv/cache?category=<id> — browse the SQLite-cached catalog. */
export async function GET(request) {
  const categoryId = new URL(request.url).searchParams.get("category");
  try {
    const status = dbStatus();
    const categories = listCategories();
    const channels = listChannels(categoryId);
    return NextResponse.json({ status, categories, channels });
  } catch (err) {
    return NextResponse.json({ error: err.message, status: null, categories: [], channels: [] });
  }
}

/** POST /api/iptv/cache[?epg=0] — sync from the provider. epg=0 skips the big XMLTV download (low-RAM devices). */
export async function POST(request) {
  const skipEpg = new URL(request.url).searchParams.get("epg") === "0";
  try {
    const started = Date.now();
    const stats = await syncAll({ skipEpg });
    return NextResponse.json({ ok: true, ms: Date.now() - started, stats, db: dbStatus() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
  }
}
