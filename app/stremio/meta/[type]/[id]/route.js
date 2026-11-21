import { NextResponse } from "next/server";
import { withCors, corsPreflight } from "@/lib/stremioCors";
import { readLibrary, cleanTitle, prettyName, showIdFor } from "@/lib/videos";
import { readAddons, streamUrl, normalizeStreams } from "@/lib/addons";
import { rankStreams } from "@/lib/rankStreams";
import { rqEnsureTorrent, riptideHost } from "@/lib/rqbit";
import { touchStream } from "@/lib/idleTorrents";
import { recordWarm } from "@/lib/warmHandoff";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() { return corsPreflight(); }

/** Fire-and-forget warm of a title's top torrent source, reusing the exact
 *  same logic as the stream route's pre-warm (addons → rank → load on the
 *  primary engine). Bounded: one shot, best-effort, never blocks the response. */
async function warmTitle(type, id) {
  try {
    const addons = (await readAddons()).filter((a) => (a.types || []).includes(type) || (a.types || []).includes("all"));
    const results = await Promise.allSettled(addons.filter((a) => /torrentio/i.test(a.id || "")).map(async (a) => {
      const r = await fetch(streamUrl(a, type, id), { headers: { "User-Agent": "HomeStream/1.0" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return [];
      return normalizeStreams((await r.json().catch(() => null))?.streams);
    }));
    const all = results.flatMap((x) => (x.status === "fulfilled" ? x.value : []));
    const best = rankStreams(all).find((s) => s.source === "torrent");
    if (!best) return;
    const u = new URL(best.url, "http://localhost");
    const h = String(u.searchParams.get("infoHash") || "").toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(h)) return;
    const host = await riptideHost();
    recordWarm(`${type}|${id}`, h);
    touchStream(h);
    await rqEnsureTorrent({ infoHash: h, nameHint: u.searchParams.get("name") || "", trackers: u.searchParams.getAll("tr"), host });
    console.log(`[meta-warm] warmed ${type}/${id} -> ${h.slice(0, 10)} on ${host ? "Riptide" : "rqbit"}`);
  } catch (e) { console.error(`[meta-warm] ${type}/${id} failed: ${String(e).slice(0, 80)}`); }
}

/** GET /stremio/meta/{type}/{id}.json — library "hs…" ids locally; tt… ids
 *  are proxied to Cinemeta so Debrify gets full metadata AND we get a hook to
 *  pre-warm that title's top source the moment the user lands on it. */
export async function GET(request, { params }) {
  const { type, id: rawId } = await params;
  const id = String(rawId || "").replace(/\.json$/i, "");
  const host = request.headers.get("host");
  const base = host ? `http://${host}` : "";

  // tt… ids: proxy Cinemeta + kick off background warm.
  if (/^tt\d+/.test(id)) {
    try {
      const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, {
        headers: { "User-Agent": "HomeStream/1.0" }, signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data?.meta) {
          warmTitle(type, id).catch(() => {}); // fire-and-forget
          return withCors(NextResponse.json({ ...data, cacheMaxAge: 0 }));
        }
      }
    } catch {}
    return withCors(NextResponse.json({ meta: null }, { status: 404 }));
  }

  // library hs… ids (unchanged)
  if (!id.startsWith("hs")) return NextResponse.json({ meta: null }, { status: 404 });
  const lib = await readLibrary();
  const videos = lib.videos || [];
  if (type === "movie") {
    const v = videos.find((x) => "hs" + x.id === id);
    if (!v) return NextResponse.json({ meta: null }, { status: 404 });
    return NextResponse.json({ meta: { id, type: "movie", name: cleanTitle(prettyName(v.name || "Untitled")), description: "HomeStream library file", playable: true } });
  }
  if (type === "series") {
    const hits = videos.filter((v) => (v.kind || "movie") === "episode" && showIdFor(v.show) === id);
    if (!hits.length) return NextResponse.json({ meta: null }, { status: 404 });
    const eps = [];
    for (const v of hits) {
      if (eps.some((e) => e.season === v.season && e.episode === v.episode)) continue;
      eps.push({ season: v.season, episode: v.episode, name: prettyName(v.name || "") });
    }
    eps.sort((a, b) => (a.season - b.season) || ((a.episode || 0) - (b.episode || 0)));
    return NextResponse.json({ meta: { id, type: "series", name: hits[0].show, description: `${eps.length} episode(s)`, videos: eps.map((e) => ({ id: `${id}:${e.season}:${e.episode ?? 0}`, title: e.name || `S${e.season}E${e.episode ?? 0}`, season: e.season, episode: e.episode ?? 0 })), playable: true } });
  }
  return NextResponse.json({ meta: null }, { status: 404 });
}
