/**
 * Rank torrent-stream candidates for THIS hardware (Pi server + phone/Fire TV
 * clients) and try them in that order.
 *
 * Why: Torrentio orders by raw quality — its top hits are 4K Dolby-Vision
 * REMUX monsters (the Titanic #1 source was a 117 GB BDRemux with a 2043h
 * ETA). The player used to cycle them in that order, so every play attempt
 * burned its whole window on a torrent the Pi could never realistically
 * serve, while well-seeded 1080p x264 sources that play beautifully sat
 * further down the list, never reached.
 *
 * Scored purely from the title text (that's what addons give us):
 *   resolution · codec · container flavor · seeders (👤) · file size (💾).
 */
export function rankStreams(streams) {
  if (!Array.isArray(streams)) return streams;
  const score = (title) => {
    const t = String(title || "");
    let s = 0;

    // --- resolution: 1080p is the sweet spot for a Pi converter ---
    if (/1080[pi]/i.test(t)) s += 40;
    else if (/720p/i.test(t)) s += 28;
    else if (/480p|576p/i.test(t)) s += 10;
    else if (/2160p|4k|uhd/i.test(t)) s += 4; // conversion-heavy on the Pi

    // --- codec: x264 converts fastest and decodes everywhere; AV1 is a ---
    // --- hardware-decode dead end on both iPhone and the Pi ---
    if (/x264|h\.?264|avc/i.test(t)) s += 18;
    else if (/x265|h\.?265|hevc/i.test(t)) s += 6;
    if (/av1/i.test(t)) s -= 60;

    // --- container flavor: REMUX/DV are the 40-120 GB unplayable monsters ---
    if (/remux/i.test(t)) s -= 30;
    if (/dolby\s*vision|\bDV\b|dovi/i.test(t)) s -= 18;
    if (/cam|ts\b|telecine|screener/i.test(t)) s -= 45;
    if (/multi|2x\s*dub|dual\s*audio/i.test(t)) s -= 22;

    // --- foreign dubs flood Torrentio's top (the Russian "Титаник" line) ---
    if (/[\u0400-\u04FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(t)) s -= 30;

    // --- seeders: "👤 N" right in the title; the single best health signal ---
    const seed = /👤\s*(\d+)/.exec(t);
    if (seed) s += Math.min(Number(seed[1]), 30) * 1.5;

    // --- size: 💾 badge or "NN GB" in the title ---
    const sizeM = /(\d+(?:\.\d+)?)\s*[Gg][bB]/.exec(t);
    const gb = sizeM ? Number(sizeM[1]) : null;
    if (gb !== null) {
      if (gb >= 25) s -= 45; // REMUX territory: days to focus, hours to convert
      else if (gb >= 10) s -= 18;
      else if (gb >= 1) s += 20; // the normal, serviceable range
      else if (gb > 0) s += 6;
    }

    return s;
  };
  return streams
    .map((x, i) => ({ x, i, s: score(x.title) }))
    .sort((a, b) => b.s - a.s || a.i - b.i) // stable: equal scores keep addon order
    .map((r) => r.x);
}
