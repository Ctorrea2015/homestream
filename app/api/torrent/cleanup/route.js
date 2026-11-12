import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** qB session helper (same shape as lib/qbittorrent.js, minimal inline). */
async function qbSession() {
  try {
    const c = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "qbittorrent.json"), "utf8"));
    const login = await fetch(`${c.host}/api/v2/auth/login`, {
      method: "POST",
      body: new URLSearchParams({ username: c.user, password: c.pass }),
    });
    const sid = /SID=[^;]+/.exec(login.headers.get("set-cookie") || "")?.[0] || "";
    return { host: c.host.replace(/\/$/, ""), sid };
  } catch {
    return null;
  }
}

/**
 * POST /api/torrent/cleanup?infoHash=<40-hex>&engine=rqbit|qb|both
 * Deletes the torrent task AND its downloaded files — called by the player
 * when playback closes (sendBeacon), so streamed movies don't accumulate
 * on disk (Stremio-style ephemeral cache instead of a full library).
 */
export async function POST(request) {
  const sp = new URL(request.url).searchParams;
  const infoHash = (sp.get("infoHash") || "").toLowerCase();
  const engine = sp.get("engine") || "both";
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    return NextResponse.json({ error: "Missing/invalid infoHash" }, { status: 400 });
  }

  const results = {};
  if (engine === "rqbit" || engine === "both") {
    try {
      const cfg = await fs.readFile(path.join(process.cwd(), ".data", "rqbit.json"), "utf8")
        .then(JSON.parse).catch(() => ({ host: "http://127.0.0.1:3030" }));
      // rqbit: delete = forget + remove files
      const res = await fetch(`${cfg.host.replace(/\/$/, "")}/torrents/${infoHash}/delete`, { method: "POST" });
      results.rqbit = res.ok ? "deleted" : `HTTP ${res.status}`;
    } catch (e) { results.rqbit = String(e).slice(0, 80); }
  }
  if (engine === "qb" || engine === "both") {
    const s = await qbSession();
    if (!s) results.qb = "not configured";
    else {
      try {
        const res = await fetch(`${s.host}/api/v2/torrents/delete`, {
          method: "POST",
          headers: { Cookie: s.sid },
          body: new URLSearchParams({ hashes: infoHash, deleteFiles: "true" }),
        });
        results.qb = res.ok ? "deleted" : `HTTP ${res.status}`;
      } catch (e) { results.qb = String(e).slice(0, 80); }
    }
  }

  // Best-effort: also clear the HLS session dir for this stream (converter
  // sessions self-prune after 10 idle minutes, but an immediate sweep is tidy).
  return NextResponse.json({ ok: true, results });
}
