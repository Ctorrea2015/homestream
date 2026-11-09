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

/** POST /api/iptv/cache — force a sync from the provider (categories+streams+EPG). */
export async function POST() {
  try {
    const started = Date.now();
    const stats = await syncAll();
    return NextResponse.json({ ok: true, ms: Date.now() - started, stats, db: dbStatus() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
  }
}
