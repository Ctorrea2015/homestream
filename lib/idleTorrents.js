/**
 * Stream-touch ledger — the server's own record of "a client is watching this
 * torrent RIGHT NOW" (or last did, N minutes ago).
 *
 * Why it exists: the web app's player announces close via a cleanup beacon,
 * but direct Stremio-protocol clients (Debrify, Stremio) hit
 * /api/torrent/stream themselves and never tell the server when playback
 * stops. Those torrents used to linger until the 3-day sweep. This ledger
 * lets the idle janitor (lib/diskSweep) clean them ~15 min after the last
 * stream read — no client cooperation needed.
 *
 * Every successful engine stream through /api/torrent/stream touches its
 * infoHash here (globalThis-backed so hot reloads / route modules share it).
 */

const g = globalThis;
if (!g.__hsStreamTouches) g.__hsStreamTouches = new Map();

export function touchStream(infoHash) {
  try { g.__hsStreamTouches.set(String(infoHash).toLowerCase(), Date.now()); } catch {}
}

export function lastStreamTouch(infoHash) {
  return g.__hsStreamTouches.get(String(infoHash || "").toLowerCase()) || null;
}

/** InfoHashes the ledger knows about (for janitor iteration). */
export function touchedHashes() {
  return [...g.__hsStreamTouches.keys()];
}

/** How long after the last stream read a torrent counts as idle. */
export const IDLE_MS = 15 * 60 * 1000;
