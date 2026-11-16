import { NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/stremioCors";
import { readLibrary, cleanTitle, prettyName, showIdFor } from "@/lib/videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /stremio/catalog/{movie|series}/hs-library.json
 * The local library as Stremio metas. Series are grouped by detected show
 * name; episodes resolve through the meta/stream endpoints.
 */
export async function GET(_request, { params }) {
  const { type } = await params;
  const lib = await readLibrary();
  const videos = lib.videos || [];

  let metas = [];
  if (type === "movie") {
    metas = videos
      .filter((v) => (v.kind || "movie") === "movie")
      .map((v) => ({
        id: "hs" + v.id,
        type: "movie",
        name: cleanTitle(prettyName(v.name || v.path || "Untitled")),
      }));
  } else if (type === "series") {
    const shows = new Map(); // show name → meta
    for (const v of videos) {
      if ((v.kind || "movie") !== "episode" || !v.show) continue;
      if (!shows.has(v.show)) {
        shows.set(v.show, {
          id: showIdFor(v.show),
          type: "series",
          name: v.show,
        });
      }
    }
    metas = [...shows.values()];
  }

  return NextResponse.json({ metas, cacheMaxAge: 300 });
}
