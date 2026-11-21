/**
 * Warm-handoff ledger — the infoHash the source list pre-warmed/prefetched
 * for a title, so ⚡ Auto plays the SAME torrent that's already downloading
 * instead of re-resolving a fresh (cold) source that makes the player quit.
 *
 * globalThis-backed so the Stremio route (which records) and the resolve
 * route (which reads) share it across module instances / hot reloads.
 */
const g = globalThis;
if (!g.__hsWarmHandoff) g.__hsWarmHandoff = new Map(); // key → { hash, at }

export function recordWarm(key, hash) {
  try { g.__hsWarmHandoff.set(key, { hash: String(hash).toLowerCase(), at: Date.now() }); } catch {}
}

export function warmHash(key) {
  const e = g.__hsWarmHandoff.get(key);
  if (!e) return null;
  if (Date.now() - e.at > 10 * 60 * 1000) { g.__hsWarmHandoff.delete(key); return null; }
  return e.hash;
}
