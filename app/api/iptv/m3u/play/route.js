import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import http from "node:http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/iptv/m3u/play?index=<n> — stream a saved M3U channel.
 * The channel list is the one /api/tv manages (.data/iptv.json); this
 * endpoint resolves the raw stream URL by index and proxies it so the client
 * never needs the provider URL. Handles HLS redirects + rewritten segments.
 */
function proxy(url, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const r = mod.get(url, {
        headers: { "User-Agent": "HomeStream/1.0 VLC/3.0", ...reqHeaders },
        timeout: 20000,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(proxy(new URL(res.headers.location, url).toString(), reqHeaders));
        }
        resolve(res);
      });
      r.on("error", reject);
      r.on("timeout", () => r.destroy());
    } catch (e) { reject(e); }
  });
}

export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  // Origin the client actually used (Host header) — never request.url.origin,
  // which is the bind address (0.0.0.0) and unreachable from a device.
  const host = request.headers.get("host") || "localhost:3000";
  const proto = (request.headers.get("x-forwarded-proto") || "http").split(",")[0];
  const self = `${proto}://${host}`;
  const seg = sp.get("seg");
  // Raw mode: pipe a single TS/channel stream (used by the generated HLS
  // playlist above, and by rewritten playlist segments).
  if (sp.get("raw") === "1") {
    const ri = Number(sp.get("index"));
    let d2 = null;
    try { d2 = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "iptv.json"), "utf8")); } catch {}
    const rch = (d2?.channels || [])[ri];
    if (!rch?.url) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    try {
      const upstream = await proxy(rch.url);
      const headers = new Headers();
      for (const h of ["content-type", "content-length", "accept-ranges"]) {
        const v = upstream.headers[h]; if (v) headers.set(h, v);
      }
      return new Response(upstream, { headers });
    } catch (e) {
      return NextResponse.json({ error: String(e?.message || e).slice(0, 80) }, { status: 502 });
    }
  }
  if (seg) {
    try {
      const upstream = await proxy(seg);
      const headers = new Headers();
      for (const h of ["content-type", "content-length", "accept-ranges"]) {
        const v = upstream.headers[h]; if (v) headers.set(h, v);
      }
      return new Response(upstream, { headers });
    } catch (e) {
      return NextResponse.json({ error: String(e?.message || e).slice(0, 80) }, { status: 502 });
    }
  }
  const index = Number(sp.get("index"));
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "Provide a channel index" }, { status: 400 });
  }
  let data;
  try {
    data = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "iptv.json"), "utf8"));
  } catch { data = null; }
  const ch = (data?.channels || [])[index];
  if (!ch?.url) return NextResponse.json({ error: "Channel not found — upload a playlist first" }, { status: 404 });

  // Raw TS / non-HLS stream: use the real ffmpeg HLS segmenter (rolling
  // 4-second segments) so players don't stop after a single fake segment.
  if (!/\.m3u8?(\?|$)/i.test(ch.url)) {
    return NextResponse.redirect(`${self}/api/iptv/hls?index=${index}`, { status: 302 });
  }

  // Rewrite .m3u8 playlist segment URLs to come back through this endpoint.
  try {
    const upstream = await proxy(ch.url);
    const type = upstream.headers["content-type"] || "application/vnd.apple.mpegurl";
    if (/mpegurl|m3u/i.test(type) || /\.m3u8/i.test(ch.url)) {
      const base = new URL(ch.url);
      let text = "";
      for await (const c of upstream) text += c.toString("utf8");
      const rewritten = text.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t || t.startsWith("#")) {
          // rewrite URI= inside #EXT-X-KEY
          return t.replace(/URI="([^"]+)"/g, (_m, u) => {
            const abs = new URL(u, base).toString();
            return `URI="${self}/api/iptv/m3u/play?seg=${encodeURIComponent(abs)}"`;
          });
        }
        const abs = new URL(t, base).toString();
        return `${self}/api/iptv/m3u/play?seg=${encodeURIComponent(abs)}`;
      }).join("\n");
      return new Response(rewritten, { headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" } });
    }
    const headers = new Headers();
    for (const h of ["content-type", "content-length", "accept-ranges"]) {
      const v = upstream.headers[h]; if (v) headers.set(h, v);
    }
    return new Response(upstream, { headers });
  } catch (e) {
    return NextResponse.json({ error: `Stream failed: ${String(e?.message || e).slice(0, 80)}` }, { status: 502 });
  }
}
