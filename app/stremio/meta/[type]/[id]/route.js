import { NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/stremioCors";
import { readLibrary, cleanTitle, prettyName, showIdFor } from "@/lib/videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /stremio/meta/{type}/{id}.json — minimal metadata for "hs…" ids.
 * Series ids decode back to the show name by matching the library's episode
 * rows against the same sha1 hash the catalog generated.
 */
export async function GET(_request, { params }) {
  const { type, id: rawId } = await params;
  const id = String(rawId || "").replace(/\.json$/i, "");
  if (!id.startsWith("hs")) {
    return NextResponse.json({ meta: null }, { status: 404 });
  }

  const lib = await readLibrary();
  const videos = lib.videos || [];

  if (type === "movie") {
    const v = videos.find((x) => "hs" + x.id === id);
    if (!v) return NextResponse.json({ meta: null }, { status: 404 });
    return NextResponse.json({
      meta: {
        id,
        type: "movie",
        name: cleanTitle(prettyName(v.name || "Untitled")),
        description: "HomeStream library file",
        playable: true,
      },
    });
  }

  if (type === "series") {
    const hits = videos.filter((v) => (v.kind || "movie") === "episode" && showIdFor(v.show) === id);
    if (!hits.length) return NextResponse.json({ meta: null }, { status: 404 });
    // Dedup by season:episode
    const eps = [];
    for (const v of hits) {
      if (eps.some((e) => e.season === v.season && e.episode === v.episode)) continue;
      eps.push({ season: v.season, episode: v.episode, name: prettyName(v.name || "") });
    }
    eps.sort((a, b) => (a.season - b.season) || ((a.episode || 0) - (b.episode || 0)));
    return NextResponse.json({
      meta: {
        id,
        type: "series",
        name: hits[0].show,
        description: `${eps.length} episode(s) in the HomeStream library`,
        videos: eps.map((e) => ({
          id: `${id}:${e.season}:${e.episode ?? 0}`,
          title: e.name || `S${e.season}E${e.episode ?? 0}`,
          season: e.season,
          episode: e.episode ?? 0,
        })),
        playable: true,
      },
    });
  }

  return NextResponse.json({ meta: null }, { status: 404 });
}
