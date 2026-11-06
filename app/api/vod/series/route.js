import { NextResponse } from "next/server";
import { fetchSeriesInfo, episodeUrl } from "@/lib/vod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Provenance key is `prov` (a source key); ids are provider-local numbers. */
const ID_RE = /^\d{1,12}$/;

/**
 * GET /api/vod/series?prov=<source key>&id=<series id>
 * Returns overview + all seasons/episodes, each with a ready-to-play url
 * (proxied through /api/tv/play the moment the player uses it).
 */
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const prov = sp.get("prov") || "";
  const id = sp.get("id") || "";
  if (!/^[0-9a-zA-Z:@.\/_-]+$/.test(prov) || !ID_RE.test(id)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  let info;
  try {
    info = await fetchSeriesInfo(prov, id);
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Provider request failed" }, { status: 502 });
  }
  if (!info || info.seasons.length === 0) {
    return NextResponse.json({ error: "No episodes were found for this series" }, { status: 404 });
  }

  for (const season of info.seasons) {
    for (const e of season.episodes) {
      e.url = episodeUrl(info.host, info.username, info.password, e.id, e.container);
      delete e.id;
    }
  }
  delete info.username;
  delete info.password;

  return NextResponse.json(info);
}
