import { NextResponse } from "next/server";
import { readIptv } from "@/lib/iptv";
import { movieUrl } from "@/lib/vod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/vod/movie-url?prov=<key>&id=<streamId>&container=mkv
 * Resolves a movie's playable provider URL on demand — used when the cached
 * catalog predates the url field (covers caches older than this fix).
 */
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const prov = sp.get("prov") || "";
  const id = sp.get("id") || "";
  const container = (sp.get("container") || "mp4").replace(/[^a-z0-9.]/gi, "");
  if (!prov || !id) return NextResponse.json({ error: "Missing prov/id" }, { status: 400 });

  const iptv = await readIptv();
  const s = (iptv.sources || []).find((x) => x.kind === "xtream" && x.key === prov);
  if (!s) return NextResponse.json({ error: "Provider not connected" }, { status: 404 });

  return NextResponse.json({ url: movieUrl(s.host, s.username, s.password, id, container) });
}
