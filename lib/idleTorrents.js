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

/**
 * Currently-open stream connections per infoHash. A player can hold ONE
 * long-lived Range connection for a whole movie — zero new HTTP requests
 * while it reads — so request-counting alone lets the janitor kill an
 * actively-watched stream (Between the Lions, 2026-11-17). A connection
 * that is open and flowing is watching, period.
 */
if (!g.__hsOpenStreams) g.__hsOpenStreams = new Map(); // infoHash → count

export function openStream(infoHash) {
  try {
    const k = String(infoHash).toLowerCase();
    g.__hsOpenStreams.set(k, (g.__hsOpenStreams.get(k) || 0) + 1);
  } catch {}
}

export function closeStream(infoHash) {
  try {
    const k = String(infoHash).toLowerCase();
    const n = (g.__hsOpenStreams.get(k) || 0) - 1;
    if (n > 0) g.__hsOpenStreams.set(k, n);
    else g.__hsOpenStreams.delete(k);
  } catch {}
}

export function hasOpenStream(infoHash) {
  return (g.__hsOpenStreams.get(String(infoHash || "").toLowerCase()) || 0) > 0;
}

/** How long after the last stream read a torrent counts as idle. */
export const IDLE_MS = 30 * 60 * 1000; // 30 min: buffered players (libmpv) can play many minutes without asking for more bytes — don't kill under them
