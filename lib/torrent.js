import path from "node:path";

/**
 * Server-side BitTorrent engine — the HomeStream equivalent of Stremio's
 * built-in torrent support. Torrents download on the SERVER and are served
 * to browsers as normal HTTP video (with Range support), so no debrid
 * service is needed.
 *
 * A real "app" like Stremio ships its own torrent client; our equivalent
 * runs here: one WebTorrent client shared by all viewers.
 */

const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "https://tracer1.openbittorrent.com/announce",
  "https://tracer2.openbittorrent.com/announce",
  "https://tracker.tamersunion.org:443/announce",
  "wss://tracker.openwebtorrent.com",
];

const MAX_TORRENTS = 3;

// Stash the client on globalThis so hot module reloads don't spawn duplicates
function server() {
  if (!globalThis.__hsTorrent) {
    globalThis.__hsTorrent = { client: null, booting: null };
  }
  return globalThis.__hsTorrent;
}

async function getClient() {
  const s = server();
  if (s.client) return s.client;
  if (s.booting) return s.booting;

  s.booting = (async () => {
    const { default: WebTorrent } = await import("webtorrent");
    const client = new WebTorrent({ maxConns: 80 });
    client.on("error", () => {}); // per-torrent errors are handled where they happen
    s.client = client;
    return client;
  })();

  const client = await s.booting;
  s.booting = null;
  return client;
}

/**
 * Find or start a torrent by infoHash; resolves once its file list is
 * known (metadata). Throws if the swarm can't be reached in time.
 */
export async function getTorrent(infoHash, waitForMs = 120000) {
  const client = await getClient();

  // Start (or reattach to) the torrent; resolve once metadata is known.
  const t = await new Promise(async (resolve, reject) => {
    const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)));
    let existing = null;
    try { existing = await client.get(infoHash); } catch {} // v2's get() is async
    if (existing && existing.ready) {
      existing._hsTouch = Date.now();
      return resolve(existing);
    }
    const timer = setTimeout(() => {
      // Don't let a never-ready torrent squat on a client slot forever —
      // remove it so the next source gets a clean chance (and re-adds work).
      (async () => {
        try {
          const stuck = await client.get(infoHash);
          if (stuck && !stuck.ready) await client.remove(stuck, { destroyStore: false });
        } catch {}
      })();
      reject(new Error("Could not reach this torrent's swarm in time — try another source"));
    }, waitForMs);
    const onErr = (err) => { clearTimeout(timer); fail(err); };
    if (existing) {
      existing.once("ready", () => { clearTimeout(timer); existing._hsTouch = Date.now(); resolve(existing); });
      existing.once("error", onErr);
      return;
    }
    // Trim to MAX_TORRENTS before adding a new one. Prefer evicting torrents
    // that never became ready (dead swarms jam the client otherwise), then
    // the least-recently-touched ready ones.
    if (client.torrents.length >= MAX_TORRENTS) {
      const rank = (t) => (t.ready ? 1000 : 0) + (t._hsTouch || 0) / 1e12;
      const oldest = [...client.torrents].sort((a, b) => rank(a) - rank(b))[0];
      if (oldest) client.remove(oldest, { destroyStore: false }, () => {});
    }
    const magnet = `magnet:?xt=urn:btih:${infoHash}` + DEFAULT_TRACKERS.map((u) => `&tr=${encodeURIComponent(u)}`).join("");
    try {
      client.add(magnet, (torrent) => {
        // add callback fires when the torrent's metadata/files are known
        clearTimeout(timer);
        torrent.once("error", onErr);
        torrent._hsTouch = Date.now();
        resolve(torrent);
      });
    } catch (err) {
      clearTimeout(timer);
      fail(err);
    }
  });

  return t;
}

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".m4v", ".avi", ".mov", ".webm", ".ts", ".flv", ".mpg", ".wmv"]);

/**
 * Choose the video file matching the source you clicked. Stremio-style
 * sources say things like "The.Mermaid.2023.2160p.WEB-DL… " — the same
 * torrent often holds several encodes, and the biggest file is NOT
 * always the one advertised. Scoring by filename overlap fixes that.
 */
export function pickVideoFile(t, nameHint = "") {
  const videoFiles = t.files
    .map((file, index) => ({ file, index, ext: path.extname(file.name).toLowerCase() }))
    .filter((x) => VIDEO_EXTS.has(x.ext));
  if (!videoFiles.length) return null;

  const words = String(nameHint || "").toLowerCase().replace(/[^\w]+/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  const hasVideoWord = (s) => /(2160p|1080p|720p|web[\s.-]?dl|blu[\s.-]?ray|remux|x264|x265|hevc|cam|ts)/i.test(s);

  const scored = videoFiles.map((x) => {
    const fn = x.file.name.toLowerCase();
    let score = words.reduce((acc, w) => acc + (fn.includes(w) ? 1 : 0), 0);
    if (words.length && score > 0 && hasVideoWord(fn)) score += 1;
    return { ...x, score };
  });

  if (words.length) {
    const best = Math.max(...scored.map((s) => s.score));
    if (best > 0) {
      const bestSet = scored.filter((s) => s.score === best);
      // among equally-matching files, favor the bigger one (full encode over extras)
      bestSet.sort((a, b) => b.file.length - a.file.length);
      return bestSet[0];
    }
  }

  // no hint / no overlap: prefer real movie files over samples/extras
  const sizeable = videoFiles.filter((x) => x.file.length > 300 * 1024 * 1024);
  if (sizeable.length) {
    sizeable.sort((a, b) => b.file.length - a.file.length);
    return sizeable[0];
  }
  videoFiles.sort((a, b) => b.file.length - a.file.length);
  return videoFiles[0];
}
