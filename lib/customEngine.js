import fs from "node:fs/promises";
import path from "node:path";

/**
 * Adapter for an EXTERNAL custom engine.
 *
 * Contract: POST <url>/streams with { type, id, title?, season?, episode? }.
 * The engine answers { provider, streams: [{ infoHash, title, seeders?, size?,
 * trackers?, ... }] }. We normalize those into HomeStream's internal torrent
 * streams (the same shape Torrentio produces), so ranking, pre-warm, rqbit
 * loading, and the whole play chain work unchanged.
 *
 * Config: .data/custom-engine.json
 *   { "enabled": true, "url": "http://127.0.0.1:4000",
 *     "apiKey": "optional", "timeoutMs": 20000 }
 * Silent no-op when disabled/unreachable — the engine can never break playback.
 */

const CONFIG_FILE = path.join(process.cwd(), ".data", "custom-engine.json");

const DEFAULT = { enabled: false, url: "", apiKey: "", timeoutMs: 20000 };

export async function customEngineConfig() {
  try {
    return { ...DEFAULT, ...JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")) };
  } catch { return { ...DEFAULT }; }
}

/** Query the external engine and normalize its answer. Never throws. */
export async function customEngineStreams({ type, id, title, season, episode }) {
  const cfg = await customEngineConfig();
  if (!cfg.enabled || !cfg.url) return [];
  try {
    const res = await fetch(`${String(cfg.url).replace(/\/$/, "")}/streams`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { "X-API-Key": String(cfg.apiKey) } : {}),
      },
      body: JSON.stringify({ type, id, title: title || "", season: season || null, episode: episode || null }),
      signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 20000),
    });
    if (!res.ok) {
      console.error(`[custom-engine] HTTP ${res.status} from ${cfg.url}`);
      return [];
    }
    const data = await res.json().catch(() => null);
    const rows = Array.isArray(data?.streams) ? data.streams : [];
    const out = [];
    for (const r of rows) {
      const hash = String(r?.infoHash || r?.info_hash || "").toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(hash)) continue;
      let t = String(r.title || r.name || "Custom engine source");
      // Give the ranker real seeder/size signals if the engine didn't put
      // badges in the title itself.
      const seeds = Number(r.seeders ?? r.seeds ?? -1);
      const bytes = Number(r.size ?? r.length ?? 0);
      if (seeds >= 0 && !/👤/.test(t)) t += ` 👤 ${seeds}`;
      if (bytes > 0 && !/💾/.test(t)) {
        const gb = bytes / 1073741824;
        t += ` 💾 ${gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`}`;
      }
      const trs = (Array.isArray(r.trackers) ? r.trackers : [])
        .filter((t) => typeof t === "string" && /^https?:\/\/|^udp:\/\//i.test(t))
        .map((t) => `&tr=${encodeURIComponent(t)}`).join("");
      out.push({
        title: t,
        url: `/api/torrent/stream?infoHash=${hash}&name=${encodeURIComponent(t).slice(0, 300)}${trs}`,
        source: "torrent",
        playable: true,
        provider: data?.provider || "custom-engine",
        seeders: seeds,
        size: bytes,
      });
    }
    if (out.length) console.log(`[custom-engine] ${out.length} sources from ${data?.provider || cfg.url}`);
    return out;
  } catch (e) {
    console.error(`[custom-engine] unreachable: ${String(e).slice(0, 90)}`);
    return [];
  }
}
