import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
// Relative imports, not "@/..." aliases: this module is loaded RAW from disk
// by instrumentation.js (webpackIgnore), where the bundler's path aliases
// don't exist — alias imports here silently killed the sweep/janitor timers.
import { lastStreamTouch, touchedHashes, IDLE_MS } from "./idleTorrents";
import { killTorrentSessions } from "./tvSessions";

/**
 * Disk sweep — the cron the torrent scratch folders needed.
 *
 * Two disk-full incidents (2026-11-13: 98 GB hoarded packs in ~/Downloads;
 * 2026-11-14: rqbit's output folder filled the SD) both came from the same
 * gap: streaming treats torrent downloads as ephemeral, but anything that
 * stalls, crashes or never gets cleaned on close keeps its bytes forever.
 *
 * Runs hourly inside the long-lived server (same lifetime as a cron on the
 * Pi), plus on demand via /api/disk/sweep. Policy:
 *   • Files in the scratch folders older than maxAgeDays (default 3) are
 *     deleted — active downloads keep touching their files, so only
 *     abandoned/stalled material goes stale.
 *   • Empty directories gone stale are removed too.
 *   • Engine torrents whose files vanished are forgotten (rqbit/qB), so the
 *     engines don't keep re-checking or redownloading ghosts.
 *   • qB torrents older than maxAgeDays (by added_on) are deleted with their
 *     files — qB tracks add time reliably.
 *   • Emergency valve: if a swept disk drops below minFreeGB (8), the
 *     OLDEST entries (older than 1 h) are deleted oldest-first until free
 *     space is back to 2× the threshold — age can't be trusted when a
 *     monster torrent starts filling the disk TODAY.
 *
 * Config (optional): .data/sweep.json
 *   { "maxAgeDays": 3, "minFreeGB": 8, "folders": ["/abs/path"] }
 */

let cfgCache = null;
async function loadCfg() {
  if (cfgCache) return cfgCache;
  let extra = {};
  try { extra = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "sweep.json"), "utf8")) || {}; } catch {}
  // Default scratch folders, always swept even when an engine is idle (an
  // idle engine reveals no output_folder, but the disk-full incident of
  // 2026-11-14 lived in exactly that situation: ~/torrents with nothing
  // running). Discovered folders are merged on top at collect time.
  const home = os.homedir();
  const defaults = [path.join(home, "torrents"), path.join(home, "Downloads")];
  cfgCache = {
    maxAgeDays: 3,
    minFreeGB: 8,
    ...extra,
    folders: [...new Set([...defaults, ...(extra.folders || [])])],
  };
  return cfgCache;
}

const rqHost = async () => {
  try {
    const c = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "rqbit.json"), "utf8"));
    if (c?.host) return c.host.replace(/\/$/, "");
  } catch {}
  return "http://127.0.0.1:3030";
};

/** qB login → { host, sid } or null (same shape as the cleanup route). */
async function qbSession() {
  try {
    const c = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "qbittorrent.json"), "utf8"));
    if (!c?.host) return null;
    const login = await fetch(`${c.host}/api/v2/auth/login`, {
      method: "POST",
      body: new URLSearchParams({ username: c.user, password: c.pass }),
      signal: AbortSignal.timeout(10000),
    });
    const sid = /SID=[^;]+/.exec(login.headers.get("set-cookie") || "")?.[0] || "";
    return { host: c.host.replace(/\/$/, ""), sid };
  } catch { return null; }
}

/** Scratch folders: discovered from the engines + any configured extras. */
async function collectFolders() {
  const cfg = await loadCfg();
  const set = new Set();
  const safe = (p) => {
    const norm = path.resolve(String(p || ""));
    // Never sweep the disk root, /home, or the user's home itself — only
    // dedicated subfolders (~/torrents, ~/Downloads, …) may ever be touched.
    const home = path.resolve(os.homedir());
    if (norm === path.parse(norm).root || norm === "/home" || norm === home) return null;
    return norm;
  };

  try {
    const base = await rqHost();
    const list = await (await fetch(`${base}/torrents`, { signal: AbortSignal.timeout(10000) })).json();
    for (const t of list?.torrents || []) {
      if (!t.output_folder) continue;
      const d = await fetch(`${base}/torrents/${t.id}`, { signal: AbortSignal.timeout(10000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (d?.output_folder) { const s = safe(d.output_folder); if (s) set.add(s); }
    }
  } catch {}

  try {
    const qb = await qbSession();
    if (qb) {
      const info = await fetch(`${qb.host}/api/v2/torrents/info`, { headers: { Cookie: qb.sid }, signal: AbortSignal.timeout(10000) })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []);
      for (const t of info || []) {
        const s = safe(t.save_path);
        if (s) set.add(s);
      }
    }
  } catch {}

  for (const f of cfg.folders || []) { const s = safe(f); if (s) set.add(s); }
  return [...set];
}

/** Recursive listing of {path, mtimeMs, size} — files only, plus dir list. */
async function walk(dir, out, dirs) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        dirs.push({ path: full, mtimeMs: (await fs.stat(full)).mtimeMs });
        await walk(full, out, dirs);
      } else if (e.isFile()) {
        const st = await fs.stat(full);
        out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch {}
  }
}

async function statFree(dir) {
  try {
    const st = await fs.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

/** Forget engine torrents whose files vanished (they'd redownload or error). */
async function reconcileEngines() {  const actions = [];
  // rqbit: any torrent whose every file is missing → pause + delete + verify.
  try {
    const base = await rqHost();
    const list = await (await fetch(`${base}/torrents`, { signal: AbortSignal.timeout(10000) })).json();
    for (const t of list?.torrents || []) {
      const det = await fetch(`${base}/torrents/${t.id}`, { signal: AbortSignal.timeout(10000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const files = det?.files || [];
      if (!files.length) continue; // no metadata yet — leave it alone
      const baseDir = det.output_folder || "";
      const allGone = files.every((f) => !fs.stat(path.join(baseDir, f.name)).then(() => true).catch(() => false));
      if (!allGone) continue;
      await fetch(`${base}/torrents/${t.info_hash}/pause`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const del = await fetch(`${base}/torrents/${t.info_hash}/delete`, { method: "POST", signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (del?.ok) actions.push(`rqbit forgot ${(t.name || t.info_hash).slice(0, 40)} (files gone)`);
    }
  } catch {}

  // qB: same reconciliation (content_path missing → delete), since qB has no
  // file-vanished detection of its own and would just error on stream reads.
  try {
    const qb = await qbSession();
    if (qb) {
      const info = await fetch(`${qb.host}/api/v2/torrents/info`, { headers: { Cookie: qb.sid }, signal: AbortSignal.timeout(10000) })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []);
      for (const t of info || []) {
        if (!t.content_path) continue;
        const exists = await fs.stat(t.content_path).then(() => true).catch(() => false);
        if (exists) continue;
        const del = await fetch(`${qb.host}/api/v2/torrents/delete`, {
          method: "POST",
          headers: { Cookie: qb.sid, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ hashes: t.hash, deleteFiles: "true" }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => null);
        if (del?.ok) actions.push(`qB forgot ${(t.name || t.hash).slice(0, 40)} (files gone)`);
      }
    }
  } catch {}
  return actions;
}

/**
 * Idle-stream janitor — the direct-client (Debrify/Stremio) cleanup path.
 * The web player beacons cleanup on close; direct clients just stop reading.
 * Any engine torrent whose infoHash was streamed but hasn't been read for
 * IDLE_MS is cleaned exactly like a player close: converter sessions killed,
 * rqbit paused-then-deleted (verified), qB deleted with files.
 */
export async function janitorOnce() {
  const actions = [];
  const now = Date.now();
  const idle = new Set(
    touchedHashes().filter((h) => {
      const at = lastStreamTouch(h);
      return at && now - at >= IDLE_MS;
    })
  );
  if (!idle.size) return actions;

  // Converter sessions die FIRST — a still-running ffmpeg reading the stream
  // is exactly what made rqbit's delete 500 (2026-11-13).
  for (const h of idle) {
    try { await killTorrentSessions(h); } catch {}
  }

  // rqbit: pause (releases active readers) → delete → verify
  try {
    const base = await rqHost();
    const list = await (await fetch(`${base}/torrents`, { signal: AbortSignal.timeout(10000) })).json();
    for (const t of list?.torrents || []) {
      const h = String(t.info_hash || "").toLowerCase();
      if (!idle.has(h)) continue;
      await fetch(`${base}/torrents/${h}/pause`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const del = await fetch(`${base}/torrents/${h}/delete`, { method: "POST", signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (del?.ok) actions.push(`rqbit: idle ${h.slice(0, 8)}… deleted`);
      idle.delete(h);
    }
  } catch {}

  // qB: delete with files
  try {
    const qb = await qbSession();
    if (qb) {
      const info = await fetch(`${qb.host}/api/v2/torrents/info`, { headers: { Cookie: qb.sid }, signal: AbortSignal.timeout(10000) })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []);
      const victims = (info || []).filter((t) => idle.has(String(t.hash || "").toLowerCase()));
      for (const t of victims) {
        const del = await fetch(`${qb.host}/api/v2/torrents/delete`, {
          method: "POST",
          headers: { Cookie: qb.sid, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ hashes: t.hash, deleteFiles: "true" }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => null);
        if (del?.ok) actions.push(`qB: idle ${t.hash.slice(0, 8)}… deleted`);
      }
    }
  } catch {}

  // Converter sessions for those hashes die first-order (they hold ffmpeg
  // reading the same files the engines just released).
  for (const h of touchedHashes()) {
    if (lastStreamTouch(h) && now - lastStreamTouch(h) >= IDLE_MS) {
      try { await killTorrentSessions(h); } catch {}
    }
  }

  // Converter sessions for those hashes die first-order (they hold ffmpeg
  // reading the same files the engines just released).
  for (const h of touchedHashes()) {
    if (lastStreamTouch(h) && now - lastStreamTouch(h) >= IDLE_MS) {
      try { await killTorrentSessions(h); } catch {}
    }
  }

  if (actions.length) console.log(`[janitor] ${actions.join(" · ")}`);
  return actions;
}

/** One full sweep pass. Returns a summary object (also logged). */
export async function sweepOnce() {
  const cfg = await loadCfg();
  const cutoff = Date.now() - cfg.maxAgeDays * 86400 * 1000;
  const folders = await collectFolders();
  const summary = { folders, deletedFiles: 0, freedBytes: 0, forgot: [], lowDisk: null };

  // Protected paths: files that belong to a torrent an engine still holds.
  // Everything else older than ORPHAN_MS in the scratch folders is a leftover
  // with no owner (its torrent was deleted or lost) — deleted after 1 h
  // instead of waiting out maxAgeDays.
  const ORPHAN_MS = 60 * 60 * 1000;
  const protectedPaths = [];
  try {
    const base = await rqHost();
    const list = await (await fetch(`${base}/torrents`, { signal: AbortSignal.timeout(10000) })).json();
    for (const t of list?.torrents || []) {
      const det = await fetch(`${base}/torrents/${t.id}`, { signal: AbortSignal.timeout(10000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      for (const f of det?.files || []) {
        if (det.output_folder) protectedPaths.push(path.join(det.output_folder, f.name).toLowerCase());
      }
    }
  } catch {}
  try {
    const qb = await qbSession();
    if (qb) {
      const info = await fetch(`${qb.host}/api/v2/torrents/info`, { headers: { Cookie: qb.sid }, signal: AbortSignal.timeout(10000) })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []);
      for (const t of info || []) {
        if (t.content_path) protectedPaths.push(String(t.content_path).toLowerCase());
      }
    }
  } catch {}
  const isProtected = (p) => {
    const lp = String(p).toLowerCase();
    return protectedPaths.some((pp) => lp === pp || lp.startsWith(pp + path.sep) || pp.startsWith(lp + path.sep));
  };

  for (const dir of folders) {
    const files = [], dirs = [];
    await walk(dir, files, dirs);

    // 1) age-based delete (stale = abandoned; active downloads stay fresh)
    //    plus the orphan rule: no owning torrent + older than 1 h → gone.
    const orphanCutoff = Date.now() - ORPHAN_MS;
    for (const f of files) {
      const stale = f.mtimeMs < cutoff;
      const orphan = f.mtimeMs < orphanCutoff && !isProtected(f.path);
      if (stale || orphan) {
        try { await fs.rm(f.path, { force: true }); summary.deletedFiles++; summary.freedBytes += f.size; } catch {}
      }
    }
    // 2) stale empty dirs (deepest first)
    dirs.sort((a, b) => b.path.length - a.path.length);
    for (const d of dirs) {
      if (d.mtimeMs >= cutoff) continue;
      try {
        const left = await fs.readdir(d.path);
        if (!left.length) { await fs.rmdir(d.path); }
      } catch {}
    }

    // 3) emergency valve: disk nearly full → oldest first, until recovered
    const free = await statFree(dir);
    if (free !== null && free < cfg.minFreeGB * 1024 ** 3) {
      const floor = Date.now() - 3600 * 1000; // never touch files younger than 1 h
      const victims = files.filter((f) => f.mtimeMs < floor).sort((a, b) => a.mtimeMs - b.mtimeMs);
      let freed = 0;
      const target = cfg.minFreeGB * 2 * 1024 ** 3;
      for (const f of victims) {
        if (free + freed >= target) break;
        try { await fs.rm(f.path, { force: true }); freed += f.size; summary.deletedFiles++; } catch {}
      }
      summary.lowDisk = { dir, freeBefore: free, freed };
      summary.freedBytes += freed;
      console.error(`[sweep] LOW DISK ${dir}: ${Math.round(free / 1024 ** 3)} GB free — emergency-pruned ${Math.round(freed / 1024 ** 3)} GB`);
    }
  }

  // 4) qB age-based delete (it tracks added_on reliably)
  try {
    const qb = await qbSession();
    if (qb) {
      const info = await fetch(`${qb.host}/api/v2/torrents/info`, { headers: { Cookie: qb.sid }, signal: AbortSignal.timeout(10000) })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []);
      const old = (info || []).filter((t) => Number(t.added_on) * 1000 < cutoff);
      if (old.length) {
        const hashes = old.map((t) => t.hash).join("|");
        const del = await fetch(`${qb.host}/api/v2/torrents/delete`, {
          method: "POST",
          headers: { Cookie: qb.sid, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ hashes, deleteFiles: "true" }),
          signal: AbortSignal.timeout(15000),
        }).catch(() => null);
        if (del?.ok) summary.forgot.push(`qB deleted ${old.length} torrent(s) older than ${cfg.maxAgeDays}d`);
      }
    }
  } catch {}

  // 5) forget engine torrents whose files vanished
  try { summary.forgot.push(...(await reconcileEngines())); } catch {}

  // 6) idle-stream janitor (direct clients like Debrify never beacon close)
  try { summary.janitor = await janitorOnce(); } catch {}

  console.log(`[sweep] ${summary.deletedFiles} file(s), ${(summary.freedBytes / 1024 ** 3).toFixed(2)} GB freed across ${folders.length} folder(s)`);
  return summary;
}

/** Start the hourly sweep — idempotent, safe to call from instrumentation. */
export function startDiskSweep() {
  const g = globalThis;
  if (g.__hsSweepTimer) return;
  g.__hsSweepState = { last: null, running: false };
  // First pass shortly after boot (clears what the last session left), then hourly.
  g.__hsSweepTimer = setInterval(async () => {
    const st = g.__hsSweepState;
    if (st.running) return;
    st.running = true;
    try { st.last = { at: new Date().toISOString(), ...(await sweepOnce()) }; }
    catch (e) { console.error("[sweep] failed:", String(e).slice(0, 120)); }
    finally { st.running = false; }
  }, 30 * 60 * 1000);
  // Janitor heartbeat: idle-torrent cleanup must run minutes after a Debrify
  // session stops, not on the next hourly sweep. Cheap: no-op without idle
  // torrents.
  g.__hsJanitorTimer = setInterval(async () => {
    try { await janitorOnce(); } catch (e) { console.error("[janitor] failed:", String(e).slice(0, 120)); }
  }, 5 * 60 * 1000);
  g.__hsJanitorTimer.unref?.();
  // but run the first pass 90 s in, not a full half hour after boot
  setTimeout(async () => {
    try { g.__hsSweepState.last = { at: new Date().toISOString(), ...(await sweepOnce()) }; }
    catch (e) { console.error("[sweep] first pass failed:", String(e).slice(0, 120)); }
  }, 90 * 1000).unref?.();
}
