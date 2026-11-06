import { NextResponse } from "next/server";
import { readVod, refreshVodFromSources } from "@/lib/vod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/vod          -> cached movies + series from your provider(s)
 * GET /api/vod?refresh=1 -> force a fresh pull from every Xtream source
 */
export async function GET(request) {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  let data = await readVod();

  // No cache yet (or a forced refresh) -> pull from the provider now.
  if (refresh || data.movies.length + data.series.length === 0) {
    data = await refreshVodFromSources();
    return NextResponse.json({ ...data, refreshing: true });
  }

  // Older than 24h -> serve cached now, client can hit refresh for fresh data.
  const stale = Date.now() - (data.refreshed || 0) > 24 * 60 * 60 * 1000;
  return NextResponse.json({ ...data, stale });
}
