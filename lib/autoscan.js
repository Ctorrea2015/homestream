import fs from "node:fs/promises";
import { readLibrary, writeLibrary, scanFolder } from "./videos.js";
import { enrichVideos } from "./tmdb.js";

/**
 * Re-scan every registered folder and merge the results, keeping any
 * metadata (posters) already fetched for files that still exist.
 * This is the "watch folder" engine — the app calls it periodically so
 * files dropped into your folders appear by themselves, jellyfin-style.
 */
export async function refreshAllFolders({ enrich = true, enrichBudget = 30 } = {}) {
  const lib = await readLibrary();
  if (lib.folders.length === 0) return { folders: 0, videos: 0, added: 0, enriched: 0 };

  const scanned = [];
  for (const root of lib.folders) {
    const found = await scanFolder(root);
    scanned.push(...found);
  }

  // Preserve previous metadata by id (posters survive re-names? no — by path id).
  const oldMeta = new Map(lib.videos.filter((v) => v.meta).map((v) => [v.id, v.meta]));
  for (const v of scanned) {
    const meta = oldMeta.get(v.id);
    if (meta) v.meta = meta;
  }

  let enrichInfo = { enriched: 0, needsKey: false };
  if (enrich) {
    try {
      enrichInfo = await enrichVideos(scanned, enrichBudget);
    } catch {
      // metadata service hiccup shouldn't break the scan
    }
  }

  await writeLibrary({ folders: lib.folders, videos: scanned });
  return { folders: lib.folders.length, videos: scanned.length, added: scanned.length, ...enrichInfo };
}

/**
 * Start the periodic watch-folder timer. Guarded with globalThis so dev
 * hot-reload doesn't stack several intervals.
 */
export function startWatchTimer(intervalMs = 10 * 60 * 1000) {
  const g = globalThis;
  if (g.__hsWatchTimer) return;
  g.__hsWatchTimer = true;

  const tick = async () => {
    try {
      await refreshAllFolders({ enrich: true, enrichBudget: 20 });
    } catch {
      // never let the timer crash the server
    }
  };

  // First sweep shortly after startup, then steady rhythm.
  // unref() so these timers don't keep the process alive unnecessarily.
  const t0 = setTimeout(tick, 15 * 1000);
  const iv = setInterval(tick, intervalMs);
  t0.unref?.();
  iv.unref?.();
}
