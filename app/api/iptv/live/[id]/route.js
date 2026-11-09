import { getChannel } from "@/lib/iptvHandler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA = "HomeStream/1.0 VLC/3.0";

/**
 * GET /api/iptv/live/:id(.m3u8)         — channel stream endpoint
 * GET /api/iptv/live/:id?seg=<abs-url>  — proxied segment (rewritten playlists
 *                                          point their segments back here)
 *
 * Backed by the SQLite cache: the id resolves to the provider stream URL
 * without touching the provider API. Playlist URLs are rewritten so every
 * segment/key also flows through this endpoint, and any upstream connection
 * that drops is retried (3 attempts, backoff) before failing the response.
 */
export async function GET(request, { params }) {
  const { id } = (await params) || {};
  const sp = new URL(request.url).searchParams;
  const seg = sp.get("seg");

  // Segment proxy mode — serve the rewritten segment URL directly.
  if (seg) {
    if (!/^https?:\/\//i.test(seg)) {
      return json({ error: "Bad segment url" }, 400);
    }
    const upstream = await fetchWithRetry(seg, request);
    if (!upstream) return json({ error: "Segment did not open after retries" }, 502);
    return pipeThrough(upstream);
  }

  // Channel mode — resolve from cache, then proxy.
  const ch = getChannel(id);
  if (!ch || !ch.url) {
    return new Response(
      JSON.stringify({
        error: `Unknown channel id: ${id}. If it was just added, run a sync first (POST /api/iptv/cache).`,
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const upstream = await fetchWithRetry(ch.url, request);
  if (!upstream) {
    return json({ error: "Stream did not open after retries — provider may be down for this channel." }, 502);
  }

  const ctype = upstream.headers.get("content-type") || "";
  const isPlaylist = /mpegurl/i.test(ctype) || /\.m3u8/i.test(ch.url);

  if (isPlaylist) {
    const text = await upstream.text();
    const base = ch.url;
    const prefix = new URL(request.url).pathname;
    const out = text.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t.startsWith("#")) {
        try { return t ? segRef(t, base, prefix) : line; } catch { return line; }
      }
      if (/URI="/i.test(t)) {
        return t.replace(/URI="([^"]+)"/i, (_, uri) => {
          try { return `URI="${segRef(uri, base, prefix)}"`; } catch { return `URI="${uri}"`; }
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

  return pipeThrough(upstream);
}

/* --------------------------------- helpers -------------------------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

/** Segment reference that loops back through this endpoint with ?seg=<abs> */
function segRef(u, base, prefix) {
  const abs = new URL(u, base).href;
  // Preserve .ts/.m3u8-ish suffix (purely cosmetic; any client still plays it)
  return `${prefix}?seg=${encodeURIComponent(abs)}`;
}

function pipeThrough(upstream) {
  const headers = {
    "Content-Type": upstream.headers.get("content-type") || "video/mp2t",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  const len = upstream.headers.get("content-length");
  if (len) headers["Content-Length"] = len;
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function fetchWithRetry(url, request) {
  const headers = { "User-Agent": UA, Accept: "*/*" };
  const range = request.headers.get("range");
  if (range) headers.Range = range;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok || res.status === 206) return res;
    } catch (err) {
      console.error(`[iptv-live] attempt ${attempt} for ${new URL(url).pathname}: ${err?.message || err}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt));
  }
  return null;
}
