import { NextResponse } from "next/server";
import { readAddons, streamUrl, normalizeStreams } from "@/lib/addons";
import { rankStreams } from "@/lib/rankStreams";
import { rqEnsureTorrent, rqWaitForData } from "@/lib/rqbit";
import { tpbFallbackStreams } from "@/lib/tpb";
import { touchStream } from "@/lib/idleTorrents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST/GET /api/torrent/resolve — "give me a IMDb id, get a playable URL".
 *
 * 1. query the configured Stremio addons (Torrentio et al) for streams
 * 2. keep ONLY raw P2P torrent sources (infoHash → our own engine URLs;
 *    debrid links and direct HTTP videos are excluded)
 * 3. rank for this hardware (1080p/x264/seeders first — see lib/rankStreams)
 * 4. load the top result into rqbit (metadata + file focus, disk guard)
 * 5. return the absolute /api/torrent/stream URL the client should open
 *
 * GET  ?id=tt0120338&type=movie
 * GET  ?id=tt0169414:1:1&type=series          (or ?id=tt0169414&s=1&e=1)
 * POST { "id": "tt0120338", "type": "movie", "wait": false }
 * Optional: wait=true → block up to 20 s for the first bytes to arrive.
 *
 * If rqbit rejects the first candidate (dead swarm, metadata timeout, disk
 * guard), the next ranked candidates are tried before giving up.
 */

const ID_RE = /^(tt\d+)(?::(\d{1,2}):(\d{1,3}))?$/;

function parseInput(src) {
  const raw = String(src?.id || src?.imdb || "").trim();
  const m = ID_RE.exec(raw);
  if (!m) throw new Error("Provide a valid IMDb id (tt1234567, or tt1234567:1:1 for series)");
  const type = ["movie", "series"].includes(String(src?.type || "").toLowerCase())
    ? String(src.type).toLowerCase()
    : "movie";
  const season = Number(m[2] ?? src?.s ?? src?.season ?? 0) || undefined;
  const episode = Number(m[3] ?? src?.e ?? src?.episode ?? 0) || undefined;
  const torrentId = type === "series" && season && episode ? `${m[1]}:${season}:${episode}` : m[1];
  return { imdbId: m[1], type, season, episode, torrentId };
}

/** Only our own engine URLs (raw torrents with a 40-char infoHash). */
function isRawP2P(s) {
  if (s?.source !== "torrent" || !s.url) return false;
  try {
    const u = new URL(s.url, "http://localhost");
    return u.pathname === "/api/torrent/stream" && /^[a-f0-9]{40}$/i.test(u.searchParams.get("infoHash") || "");
  } catch { return false; }
}

async function addonSources(type, torrentId) {
  const addons = (await readAddons()).filter(
    (a) => (a.types || []).includes(type) || (a.types || []).includes("all")
  );
  const results = await Promise.allSettled(addons.map(async (a) => {
    const res = await fetch(streamUrl(a, type, torrentId), {
      headers: { "User-Agent": "HomeStream/1.0" },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return normalizeStreams(data?.streams);
  }));
  const out = [];
  for (const r of results) if (r.status === "fulfilled") out.push(...r.value);
  return out;
}

async function resolve(request, body) {
  let p;
  try { p = parseInput({ ...body, ...Object.fromEntries(request.nextUrl.searchParams) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String(e.message || e) }, { status: 400 }); }

  const host = request.headers.get("host");
  if (!host) return NextResponse.json({ ok: false, error: "No Host header" }, { status: 400 });
  const proto = (request.headers.get("x-forwarded-proto") || request.nextUrl.protocol.replace(":", "")).split(",")[0];
  const base = `${proto}://${host}`;

  // 1–2. sources → raw P2P only
  let candidates = (await addonSources(p.type, p.torrentId)).filter(isRawP2P);
  let provider = "addons";
  if (!candidates.length) {
    // Same last-resort provider the Stremio surface uses: apibay when the
    // addon scrapers come up empty.
    candidates = (await tpbFallbackStreams({
      type: p.type, ttId: p.imdbId, season: p.season, episode: p.episode, base,
    })).filter(isRawP2P);
    provider = "tpb";
  }
  if (!candidates.length) {
    return NextResponse.json(
      { ok: false, error: `No raw P2P torrent sources for ${p.torrentId} right now` },
      { status: 404 }
    );
  }

  // 3. rank, 4. load into rqbit (try a few if the top swarms are dead)
  const ranked = rankStreams(candidates);
  const epTag = p.type === "series" && p.season && p.episode
    ? ` S${String(p.season).padStart(2, "0")}E${String(p.episode).padStart(3, "0")}`
    : "";
  const errors = [];
  for (const cand of ranked.slice(0, 3)) {
    const abs = new URL(cand.url, base);
    const infoHash = String(abs.searchParams.get("infoHash") || "").toLowerCase();
    const nameHint = (abs.searchParams.get("name") || "") + epTag;
    if (epTag) abs.searchParams.set("name", nameHint);
    const trackers = abs.searchParams.getAll("tr");
    try {
      // Keep the janitor from eating this registration before the client
      // even connects (fresh torrents have no files on disk yet).
      touchStream(infoHash);
      const loaded = await rqEnsureTorrent({ infoHash, nameHint, trackers });
      if (!loaded) throw new Error("rqbit engine unavailable");

      // Best-effort warm read: pulls the head through our own stream route,
      // which drives rqbit's piece prioritization and primes head+tail.
      fetch(abs, {
        headers: { Range: "bytes=0-1048575", "User-Agent": "HomeStream/1.0 VLC/3.0" },
        signal: AbortSignal.timeout(30000),
      }).then((r) => r.arrayBuffer()).then(() => touchStream(infoHash)).catch(() => {});

      // Optional: block until the first pieces actually arrive.
      let ready = null;
      if (String(body?.wait ?? request.nextUrl.searchParams.get("wait") ?? "") === "true" ||
          String(body?.wait ?? request.nextUrl.searchParams.get("wait") ?? "") === "1") {
        const id = /\/torrents\/(\d+)\//.exec(loaded.streamUrl)?.[1];
        ready = id ? await rqWaitForData(id, infoHash, 20000) : null;
      }

      return NextResponse.json({
        ok: true,
        engine: "rqbit",
        provider,
        imdbId: p.imdbId,
        type: p.type,
        season: p.season || null,
        episode: p.episode || null,
        infoHash,
        title: cand.title,
        candidates: ranked.length,
        file: loaded.name,
        size: loaded.size,
        ready,
        streamUrl: abs.toString(),
        rqbitStreamUrl: loaded.streamUrl,
      });
    } catch (e) {
      errors.push(`${infoHash.slice(0, 10)}: ${String(e?.message || e).slice(0, 90)}`);
    }
  }
  return NextResponse.json(
    { ok: false, error: "rqbit could not load any of the top sources", attempts: errors },
    { status: 502 }
  );
}

export async function GET(request) { return resolve(request, {}); }
export async function POST(request) {
  return resolve(request, await request.json().catch(() => ({})));
}
