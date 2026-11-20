import { NextResponse } from "next/server";
import { customEngineConfig, customEngineStreams } from "@/lib/customEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/custom-engine/health — config + connectivity.
 *  GET /api/custom-engine/health?id=tt0120338&type=movie — one live test query. */
export async function GET(request) {
  const cfg = await customEngineConfig();
  const id = request.nextUrl.searchParams.get("id");
  let probe = null;
  if (id) {
    const streams = await customEngineStreams({
      type: request.nextUrl.searchParams.get("type") || "movie",
      id,
    });
    probe = { id, count: streams.length, titles: streams.slice(0, 5).map((s) => s.title) };
  }
  return NextResponse.json({
    enabled: cfg.enabled,
    url: cfg.url || null,
    hasApiKey: Boolean(cfg.apiKey),
    timeoutMs: cfg.timeoutMs,
    probe,
  });
}
