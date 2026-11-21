import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/downloads — what's downloading right now, across all engines.
 * Riptide (primary), rqbit daemon (backup), qBittorrent (backend of Riptide).
 * Returns a flat list: { engine, name, infoHash, progress, speed, peers, seeders, size, eta, status }.
 */

async function readCfg(name, fallback = {}) {
  try { return JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", name), "utf8")) || fallback; }
  catch { return fallback; }
}

async function getJson(url, ms = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Riptide and rqbit speak the same API — one fetcher for both. */
async function fromRqbitApi(host, label) {
  if (!host) return [];
  const list = await getJson(`${host}/torrents`);
  const out = [];
  for (const t of list.torrents || []) {
    let stats = null, detail = null;
    try { stats = await getJson(`${host}/torrents/${t.id}/stats`, 4000); } catch {}
    try { detail = await getJson(`${host}/torrents/${t.id}`, 4000); } catch {}
    const snap = stats?.snapshot || {};
    const fetched = Number(snap.fetched_bytes ?? snap.downloaded_and_checked_bytes ?? 0);
    const speed = stats?.download_speed?.human_readable || "0 B/s";
    const peers = Number(snap.peer_stats?.live ?? 0);
    const seeders = Number(snap.peer_stats?.live_seeders ?? 0);
    // Total size lives in the file list, not the torrent list — sum the files.
    const files = detail?.files || detail?.details?.files || [];
    const size = files.reduce((n, f) => n + Number(f.length ?? f.file_length ?? f.size ?? 0), 0) || Number(t.size ?? t.total_bytes ?? 0);
    const progress = size > 0 ? Math.min(100, Math.round((fetched / size) * 100)) : null;
    out.push({
      engine: label,
      id: t.id,
      infoHash: (t.info_hash || "").slice(0, 12),
      fullHash: String(t.info_hash || "").toLowerCase(),
      name: t.name || "(resolving metadata…)",
      progress,
      speed,
      peers,
      seeders,
      size,
      eta: stats?.time_remaining?.human_readable || null,
      status: stats?.error_kind ? String(stats.human_readable || stats.error_kind).slice(0, 60) : (peers === 0 ? "waiting for peers" : "downloading"),
    });
  }
  return out;
}

/** qBittorrent WebUI (Riptide's backend). */
async function fromQb(cfg) {
  if (!cfg?.host) return [];
  const base = cfg.host.replace(/\/$/, "");
  let cookie = "";
  try {
    const r = await fetch(`${base}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: cfg.user || "admin", password: cfg.pass || "" }),
      signal: AbortSignal.timeout(5000),
    });
    const sc = r.headers.get("set-cookie") || "";
    if (r.ok) cookie = /SID=[^;]+/.exec(sc)?.[0] || "";
  } catch { return []; }
  try {
    const r = await fetch(`${base}/api/v2/torrents/info`, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const all = await r.json();
    return (Array.isArray(all) ? all : []).map((t) => ({
      engine: "qB",
      id: null,
      name: t.name || "?",
      infoHash: String(t.hash || "").slice(0, 12),
      fullHash: String(t.hash || "").toLowerCase(),
      progress: Math.round((t.progress || 0) * 100),
      speed: `${((t.dlspeed || 0) / 1048576).toFixed(2)} MiB/s`,
      peers: (t.num_leechs || 0) + (t.num_seeds || 0),
      seeders: t.num_seeds || 0,
      size: t.total_size || 0,
      eta: t.eta && t.eta > 0 && t.eta < 8640000 ? `${Math.round(t.eta / 60)} min` : null,
      status: t.state || "idle",
    }));
  } catch { return []; }
}

export async function GET() {
  const rip = await readCfg("riptide.json");
  const rq = await readCfg("rqbit.json", { host: "http://127.0.0.1:3030" });
  const qb = await readCfg("qbittorrent.json");

  const results = await Promise.allSettled([
    rip?.enabled && rip?.host ? fromRqbitApi(rip.host, "Riptide") : Promise.resolve([]),
    fromRqbitApi(rq?.host, "rqbit"),
    fromQb(qb),
  ]);
  const downloads = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  // show Riptide's view once — qB is its backend and would double-count
  const deduped = downloads.filter((d, i, arr) =>
    !(d.engine === "qB" && arr.some((x) => x.engine === "Riptide" && x.infoHash === d.infoHash))
  );
  return NextResponse.json({ downloads: deduped, at: new Date().toISOString() });
}
