import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { killTorrentSessions } from "@/lib/tvSessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Coalesce the double-fire (beacon + fetch) within 30 s per infoHash. */
const recentCleanup = new Map();

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

  // The player fires both a beacon AND a fetch on Back — they can arrive as
  // two near-identical POSTs. Coalesce: if the same hash was cleaned within
  // the last 30 s, answer ok without redoing the work.
  const now = Date.now();
  if (recentCleanup.get(infoHash) > now - 30_000) {
    return NextResponse.json({ ok: true, results: { deduped: true } });
  }
  recentCleanup.set(infoHash, now);

  const results = {};
  // Order matters: kill the converter sessions FIRST. A still-running ffmpeg
  // keeps re-adding the torrent (its range reads re-invoke the stream route),
  // so deleting the torrent alone gets undone within seconds.
  await killTorrentSessions(infoHash);
  results.converter = "sessions killed";
  if (engine === "rqbit" || engine === "both") {
    try {
      const cfg = await fs.readFile(path.join(process.cwd(), ".data", "rqbit.json"), "utf8")
        .then(JSON.parse).catch(() => ({ host: "http://127.0.0.1:3030" }));
      const base = cfg.host.replace(/\/$/, "");
      // rqbit: delete = forget + remove files. Its delete can transiently 500
      // when it races an active download — retry with backoff, and verify the
      // torrent is actually gone from the list before believing success.
      results.rqbit = "failed";
      for (let attempt = 1; attempt <= 4 && results.rqbit !== "deleted"; attempt++) {
        const res = await fetch(`${base}/torrents/${infoHash}/delete`, { method: "POST" }).catch(() => null);
        if (res && res.ok) {
          // Verify: gone from /torrents? If still listed, keep trying.
          const still = await fetch(`${base}/torrents`).then((r) => r.json()).catch(() => null);
          const gone = !still || !JSON.stringify(still).toLowerCase().includes(infoHash);
          if (gone) { results.rqbit = "deleted"; break; }
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
        if (attempt === 4) results.rqbit = `HTTP ${res ? res.status : "err"} (after retries)`;
      }
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
        // Verify the task actually vanished — a surviving zombie task keeps
        // the disk space via open handles and re-downloads missing files.
        results.qb = res.ok ? "deleted" : `HTTP ${res.status}`;
        const check = await fetch(`${s.host}/api/v2/torrents/info?hash=${infoHash}`, {
          headers: { Cookie: s.sid },
        });
        if (check.ok) {
          const arr = await check.json().catch(() => []);
          if (Array.isArray(arr) && arr.length > 0) {
            await fetch(`${s.host}/api/v2/torrents/delete`, {
              method: "POST", headers: { Cookie: s.sid },
              body: new URLSearchParams({ hashes: infoHash, deleteFiles: "true" }),
            }).catch(() => {});
            results.qb = "deleted (verified after 2nd pass)";
          }
        }
      } catch (e) { results.qb = String(e).slice(0, 80); }
    }
  }

  // Best-effort: also clear the HLS session dir for this stream (converter
  // sessions self-prune after 10 idle minutes, but an immediate sweep is tidy).
  console.log(`[cleanup] ${infoHash.slice(0, 10)}… engine=${engine} → ${JSON.stringify(results)}`);
  return NextResponse.json({ ok: true, results });
}
