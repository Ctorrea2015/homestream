import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Shared HLS session registry (moved out of the transcode route so other
 * routes — e.g. torrent cleanup — can kill a movie's converter session).
 *
 * Map: sessionId → { dir, child, last }
 * Map: torrentInfoHash → Set<sessionId>  (registered when the feed is a
 * /api/torrent/stream URL; lets cleanup find sessions by infoHash even
 * though session ids hash the full target URL).
 */

const HLS_ROOT = path.join(process.cwd(), ".data", "hls");
export const hlsSessions = new Map();
const torrentSessions = new Map(); // infoHash → Set of session ids

export function sessionIdFor(target) {
  return crypto.createHash("sha1").update(target).digest("hex").slice(0, 12);
}

export function registerTorrentSession(infoHash, id) {
  const key = infoHash.toLowerCase();
  if (!torrentSessions.has(key)) torrentSessions.set(key, new Set());
  torrentSessions.get(key).add(id);
}

/** Kill a session: SIGKILL ffmpeg, remove its dir, forget it. */
export async function killSession(id) {
  const s = hlsSessions.get(id);
  if (s) {
    try { s.child.kill("SIGKILL"); } catch {}
    await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
    hlsSessions.delete(id);
  }
}

/** Kill every converter session belonging to a torrent (by infoHash). */
export async function killTorrentSessions(infoHash) {
  const key = (infoHash || "").toLowerCase();
  const ids = torrentSessions.get(key);
  if (!ids) return;
  for (const id of ids) await killSession(id);
  torrentSessions.delete(key);
}

let pruneTimer = null;
export function startPrune() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of hlsSessions) {
      if (now - s.last > 10 * 60 * 1000) {
        s.child.kill("SIGKILL");
        fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
        hlsSessions.delete(id);
        for (const [, set] of torrentSessions) set.delete(id);
      }
    }
  }, 60_000);
}

export { HLS_ROOT };
