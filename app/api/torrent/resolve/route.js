import { NextResponse } from "next/server";
import { readAddons, streamUrl, normalizeStreams } from "@/lib/addons";
import { rankStreams } from "@/lib/rankStreams";
import { qbEnsureTorrent } from "@/lib/qbittorrent";
import { rqEnsureTorrent, rqWaitForData, rqPeerCount, riptideHost } from "@/lib/rqbit";
import { tpbFallbackStreams } from "@/lib/tpb";
import { customEngineStreams } from "@/lib/customEngine";
import { touchStream } from "@/lib/idleTorrents";
import { warmHash } from "@/lib/warmHandoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST/GET /api/torrent/resolve — "give me a IMDb id, get a playable URL".
 *
 * 1. query the configured Stremio addons (Torrentio et al) for streams
 * 2. keep ONLY raw P2P torrent sources (infoHash → our own engine URLs;
 *    debrid links and direct HTTP videos are excluded)
 * 3. rank for this hardware (1080p/x264/seeders first — see lib/rankStreams)
 * 4. pre-load the top result into qB (primary, disk-based) — rqbit is the
 *    backup if qB isn't configured or rejects the source
 * 5. return the absolute /api/torrent/stream URL the client should open
 *
 * GET  ?id=tt0120338&type=movie
 * GET  ?id=tt0169414:1:1&type=series          (or ?id=tt0169414&s=1&e=1)
 * POST { "id": "tt0120338", "type": "movie", "wait": false }
 * Optional: wait=true → block up to 20 s for the first bytes to arrive.
 *
 * If the loader rejects the first candidate (dead swarm, metadata timeout,
 * disk guard), the next ranked candidates are tried before giving up.
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
  let provider = candidates.length ? "addons" : "";
  const custom = (await customEngineStreams({
    type: p.type, id: p.torrentId, season: p.season, episode: p.episode,
  })).filter(isRawP2P);
  if (custom.length) {
    candidates.push(...custom);
    provider = provider ? `${provider}+custom` : "custom-engine";
  }
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

  // 2.5. Year gate — addon results for a 2012 movie often include a hot 2023
  // sequel ("Ballad of Songbirds & Snakes") whose fresh swarm outranks the
  // original's stale badges. Filter out sources advertising a different year.
  if (p.type === "movie") {
    let wantedYear = null;
    try {
      const j = await (await fetch(`https://cinemeta-live.strem.io/meta/movie/${p.imdbId}.json`, {
        signal: AbortSignal.timeout(8000),
      })).json().catch(() => null);
      const rel = String(j?.meta?.releaseInfo || j?.meta?.year || "");
      const y = /(\d{4})/.exec(rel);
      if (y) wantedYear = y[1];
    } catch {}
    if (wantedYear) {
      const before = candidates.length;
      candidates = candidates.filter((s) => {
        const title = new URL(s.url, base).searchParams.get("name") || s.title || "";
        const yrs = [...title.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
        // Keep if no year is advertised, or one of them matches the IMDb year.
        return yrs.length === 0 || yrs.includes(wantedYear);
      });
      console.log(`[resolve] year gate ${wantedYear}: ${before} -> ${candidates.length} sources`);
    }
  }
  if (!candidates.length) {
    return NextResponse.json(
      { ok: false, error: `No sources match ${p.torrentId}${p.type === "movie" ? " (year gate)" : ""}` },
      { status: 404 }
    );
  }

  // 3. rank, 4. pre-load into rqbit (the PRIMARY engine) so playback starts
  //    instantly. qB is only the fallback if rqbit can't load the source.
  //    Both engines return the SAME /api/torrent/stream URL (abs) — but
  //    pre-loading here means data is already flowing when the player connects.
  const ranked = rankStreams(candidates);
  // Reuse the prefetched torrent for this title if it's still among the
  // candidates (same swarm, already downloading) — put it first so the player
  // connects to warm bytes instead of a cold source.
  const warmed = warmHash(`${p.type}|${p.torrentId}`);
  if (warmed) {
    const i = ranked.findIndex((s) => {
      const u = new URL(s.url, base);
      return u.searchParams.get("infoHash")?.toLowerCase() === warmed;
    });
    if (i > 0) ranked.unshift(ranked.splice(i, 1)[0]);
  }
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
    let deadSwarm = false;
    try {
      // Keep the janitor from eating this registration before the client
      // even connects (fresh torrents have no files on disk yet).
        touchStream(infoHash);

        // Riptide first (when configured), then rqbit as backup loader.
        const primaryHost = await riptideHost();
        let loaded = null;
        let engine = primaryHost ? "Riptide" : "rqbit";
        let loadedHost = primaryHost || null;   // host of the engine that actually loaded it
        let rqbitStreamUrl = null;
        let ready = null;
        for (const candidate of [
          ...(primaryHost ? [{ name: "Riptide", host: primaryHost }] : []),
          { name: "rqbit", host: null },
        ]) {
          try {
            const r = await rqEnsureTorrent({ infoHash, nameHint, trackers, host: candidate.host });
            if (r) {
              loaded = { name: r.name, size: r.size };
              rqbitStreamUrl = r.streamUrl;
              engine = candidate.name;
              loadedHost = candidate.host;
              break;
            }
          } catch (e) {
            const msg = String(e?.message || e);
            // Riptide's seeder gate returns 409 for a DEAD SWARM — that source
            // is unusable. Skip it entirely (try the next ranked candidate)
            // instead of forcing it into rqbit where it stalls at 0 bytes.
            if (candidate.name === "Riptide" && /409|dead_swarm|no live seeders/i.test(msg)) {
              errors.push(`${infoHash.slice(0, 10)}: Riptide rejected dead swarm — trying next source`);
              deadSwarm = true;
              break;
            }
            errors.push(`${infoHash.slice(0, 10)}: ${candidate.name}: ${msg.slice(0, 70)}`);
          }
        }
      if (!loaded && !deadSwarm) {
        // Fallback loader: qB (disk-based, for sources rqbit can't resolve).
        try {
          const q = await qbEnsureTorrent({ infoHash, nameHint, trackers, waitMs: 15000 });
          if (q) {
            loaded = { name: q.name, size: q.size };
            engine = "qb";
            loadedHost = "qb";     // qB has no /torrents/{hash}/stats — skip rqbit-style verification
          }
        } catch (e) {
          errors.push(`${infoHash.slice(0, 10)}: qb: ${String(e?.message || e).slice(0, 70)}`);
        }
      }
      if (deadSwarm) continue;                    // try the next ranked source
      if (!loaded) throw new Error("no engine could load this source");

      // Fire the warm read FIRST — it triggers the engine to start pulling the
      // head pieces, so the byte-flow check below has something to detect.
      fetch(abs, {
        headers: { Range: "bytes=0-1048575", "User-Agent": "HomeStream/1.0 VLC/3.0" },
        signal: AbortSignal.timeout(30000),
      }).then((r) => r.arrayBuffer()).then(() => touchStream(infoHash)).catch(() => {});

      // Peer-first verification — skip dead swarms INSTANTLY. Give peers ~3s
      // to connect (they don't appear the instant a torrent is added), then:
      //   • 0 connected peers → dead source, skip to next (no 15s byte-wait)
      //   • peers present → wait up to 15s for real bytes before deciding
      //   • unknown (-1) → fall through to byte-wait (don't skip blindly)
      let flowOk = true; // default: don't block when we can't verify
      // qB has no rqbit-style stats API — verify byte flow via the warm read
      // below instead; the rqbit-family check only applies to Riptide/rqbit.
      if (engine !== "qb") {
        const rid = infoHash; // stream URL now uses the hash; use it directly for stats polling
        if (rid) {
          const host = loadedHost;
          await new Promise((r) => setTimeout(r, 1500)); // brief grace for peers to connect
          const peers = await rqPeerCount(rid, host);
          if (peers.live === 0) {
            console.log(`[resolve] ${infoHash.slice(0, 10)} 0 peers on ${engine} — dead source, skipping instantly`);
            errors.push(`${infoHash.slice(0, 10)}: 0 peers (${engine}) — skipping`);
            continue; // next ranked candidate — no byte-wait needed
          }
          flowOk = await rqWaitForData(rid, infoHash, 8000, host);
          if (!flowOk) {
            console.log(`[resolve] ${infoHash.slice(0, 10)} loaded on ${engine} but no bytes in 8s — dead source, trying next`);
            errors.push(`${infoHash.slice(0, 10)}: no first bytes in 8s (${engine}) — skipping`);
            continue; // next ranked candidate
          } else {
            console.log(`[resolve] ${infoHash.slice(0, 10)} first bytes confirmed on ${engine} (${peers.live} peers)`);
          }
        }
      }

      // Optional: block until the first pieces actually arrive (rqbit only).
      if (String(body?.wait ?? request.nextUrl.searchParams.get("wait") ?? "") === "true" ||
          String(body?.wait ?? request.nextUrl.searchParams.get("wait") ?? "") === "1") {
        ready = await rqWaitForData(infoHash, infoHash, 20000, engine === "qb" ? null : loadedHost);
      }

      return NextResponse.json({
        ok: true,
        engine,
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
        rqbitStreamUrl,
      });
    } catch (e) {
      errors.push(`${infoHash.slice(0, 10)}: ${String(e?.message || e).slice(0, 90)}`);
    }
  }
  return NextResponse.json(
    { ok: false, error: "no engine could load any of the top sources", attempts: errors },
    { status: 502 }
  );
}

export async function GET(request) { return resolve(request, {}); }
export async function POST(request) {
  return resolve(request, await request.json().catch(() => ({})));
}
