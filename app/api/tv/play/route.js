import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_CACHE = { "Cache-Control": "no-store" };

function proxyUrl(target) {
  return `/api/tv/play?u=${encodeURIComponent(target)}`;
}

/**
 * GET /api/tv/play?u=<stream url>
 *
 * ALL IPTV traffic goes through this server-side proxy. This is what makes
 * IPTV actually work in a browser:
 *  1. Browsers refuse to play media streams that don't send CORS headers —
 *     most IPTV servers don't. We fetch on the server (no CORS between
 *     server-to-server) and re-serve locally.
 *  2. HLS playlists contain RELATIVE segment URLs. We rewrite every playlist
 *     line so its segments/keys also come back through this proxy.
 */
export async function GET(request) {
  const target = new URL(request.url).searchParams.get("u");
  if (!target) return NextResponse.json({ error: "Missing stream url" }, { status: 400 });
  if (!/^https?:\/\//i.test(target)) {
    return NextResponse.json({ error: "Only http(s) streams are supported" }, { status: 400 });
  }

  // Forward Range (movies are files — browsers scrub with byte ranges).
  const range = request.headers.get("range");
  const reqHeaders = {
    "User-Agent": "HomeStream/1.0 VLC/3.0",
    Accept: "*/*",
  };
  if (range) reqHeaders["Range"] = range;

  let upstream;
  try {
    upstream = await fetch(target, {
      cache: "no-store",
      headers: reqHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return NextResponse.json({ error: `Stream unreachable: ${err?.message || String(err)}` }, { status: 502 });
  }

  if (!upstream.ok && upstream.status !== 206) {
    // A rejected Range simply means "not ranged" — fetch again without one.
    let refetched = null;
    if (range) {
      try {
        refetched = await fetch(target, {
          cache: "no-store",
          headers: { "User-Agent": "HomeStream/1.0 VLC/3.0", Accept: "*/*" },
          redirect: "follow",
        });
      } catch {}
    }
    if (!refetched || !(refetched.ok || refetched.status === 206)) {
      return NextResponse.json({ error: `Upstream returned HTTP ${upstream.status}` }, { status: 502 });
    }
    upstream = refetched;
  }

  const type = upstream.headers.get("content-type") || "";
  const isPlaylist = /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i.test(type) || /\.m3u8($|\?)/i.test(target);

  // Rewritten playlist -> every internal reference points at this proxy.
  if (isPlaylist) {
    const text = await upstream.text();
    const base = target;
    const out = text.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t.startsWith("#")) {
        // plain URL — resolve relative, proxy it
        try {
          return t ? proxyUrl(new URL(t, base).href) : line;
        } catch {
          return line;
        }
      }
      // any tag with an embedded URI="..." (keys, maps, audio, subtitles)
      if (/URI="/i.test(t)) {
        return t.replace(/URI="([^"]+)"/i, (_, uri) => {
          try {
            return `URI="${proxyUrl(new URL(uri, base).href)}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      return line;
    });
    return new Response(out.join("\n"), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Anything else (TS segments, mp4/mkv files, audio, subtitles) -> pipe through
  // untouched, preserving Range/206 behaviour for smooth movie scrubbing.
  const headers = {
    "Content-Type": type || (upstream.status === 206 ? "video/mp2t" : "application/octet-stream"),
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
  if (upstream.status === 206) headers["Content-Range"] = upstream.headers.get("content-range") || "";
  const len = upstream.headers.get("content-length");
  if (len) headers["Content-Length"] = len;
  return new Response(upstream.body, { status: upstream.status, headers });
}
