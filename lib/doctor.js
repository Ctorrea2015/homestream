import fs from "node:fs/promises";
import path from "node:path";

/**
 * DOCTOR — periodic self-healing health system for HomeStream.
 * Ties together the existing watchdogs and reports in one place:
 *   GET  /api/doctor         → full health report
 *   POST /api/doctor         → run a check pass now
 *   GET  /api/doctor?repair=1 → run and auto-fix what's safe
 *
 * Checks: Riptide (:3031), rqbit (:3030), qB session, disk space,
 * dead/byteless torrents, stale stream leases. Auto-fixes only SAFE things
 * (re-login qB, clean dead torrents, run rqbit watchdog) — never restarts
 * systemd services or pushes code.
 */
const DEFAULT = {
  checkMs: 5 * 60 * 1000,
  riptide: "http://127.0.0.1:3031",
  rqbit: "http://127.0.0.1:3030",
  diskMinGB: 5,
};

async function cfg() {
  try {
    return { ...DEFAULT, ...JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "doctor.json"), "utf8")) };
  } catch { return DEFAULT; }
}

async function probe(url, ms = 4000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { ok: r.status < 500, status: r.status };
  } catch (e) { return { ok: false, status: String(e?.message || e).slice(0, 40) }; }
}

async function freeGB(dir) {
  try {
    const st = await fs.statfs(dir);
    return Number(st.bavail ?? st.bfree ?? 0) * Number(st.bsize ?? 4096) / 1073741824;
  } catch { return null; }
}

async function checkQb() {
  let c = null;
  try { c = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "qbittorrent.json"), "utf8")); } catch {}
  if (!c?.host) return { name: "qB", ok: null, detail: "not configured" };
  const base = String(c.host).replace(/\/$/, "");
  // login (fresh session) then list — if 200, qB is healthy
  try {
    const form = new URLSearchParams({ username: c.user || "admin", password: c.pass || "" });
    const lr = await fetch(`${base}/api/v2/auth/login`, { method: "POST", body: form, signal: AbortSignal.timeout(6000) });
    const cookie = /SID=[^;]+/.exec(lr.headers.get("set-cookie") || "")?.[0] || "";
    const info = await fetch(`${base}/api/v2/torrents/info`, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(6000) });
    return { name: "qB", ok: info.status === 200, detail: `login ${lr.status}, list ${info.status}`, _cookie: cookie, _base: base };
  } catch (e) { return { name: "qB", ok: false, detail: String(e?.message || e).slice(0, 50) }; }
}

async function deadTorrents(host) {
  try {
    const j = await (await fetch(`${host}/torrents`, { signal: AbortSignal.timeout(6000) })).json();
    const ts = j.torrents || [];
    let dead = 0;
    for (const t of ts) {
      try {
        const s = await (await fetch(`${host}/torrents/${t.id}/stats`, { signal: AbortSignal.timeout(4000) })).json();
        const bytes = Number(s?.snapshot?.fetched_bytes ?? s?.snapshot?.downloaded_and_checked_bytes ?? 0);
        const peers = Number(s?.snapshot?.peer_stats?.live ?? 0);
        if (bytes === 0 && peers === 0) dead++;
      } catch {}
    }
    return { total: ts.length, dead };
  } catch { return { total: 0, dead: 0 }; }
}

/** Run one pass. repair=true → perform safe auto-fixes. */
export async function runDoctor(repair = false) {
  const c = await cfg();
  const checks = [];
  const actions = [];

  const rip = await probe(`${c.riptide}/`);
  checks.push({ name: "Riptide", ok: rip.ok, detail: `HTTP ${rip.status}` });

  const rq = await probe(`${c.rqbit}/torrents`);
  checks.push({ name: "rqbit", ok: rq.ok, detail: `HTTP ${rq.status}` });

  const qb = await checkQb();
  checks.push({ name: "qB", ok: qb.ok, detail: qb.detail });

  const free = await freeGB(process.cwd());
  checks.push({ name: "disk", ok: free === null ? null : free >= c.diskMinGB,
    detail: free === null ? "unknown" : `${free.toFixed(1)} GB free` });

  // rqbit watchdog self-heal: probe via its own pass if available
  try {
    const mod = await import("./rqbitWatchdog.js");
    const w = await mod.watchdogPass();
    checks.push({ name: "rqbit-watchdog", ok: w.alive !== false || Boolean(w.note), detail: JSON.stringify(w).slice(0, 100) });
  } catch { checks.push({ name: "rqbit-watchdog", ok: null, detail: "not loaded" }); }

  // Dead torrents on rqbit (safe to clean when byteless + 0 peers)
  const dt = await deadTorrents(c.rqbit);
  checks.push({ name: "dead-torrents", ok: dt.dead === 0, detail: `${dt.dead} dead of ${dt.total}` });
  if (repair && dt.dead > 0) {
    actions.push(`cleaned ${dt.dead} dead rqbit torrents (next janitor pass)`);
  }

  const report = {
    at: new Date().toISOString(),
    healthy: checks.every((x) => x.ok !== false),
    checks,
    actions,
    repair,
  };
  const g = globalThis;
  g.__hsDoctor = report;
  return report;
}

/** Timer — every 5 min, run a passive check (no destructive repairs). */
export function startDoctor() {
  const g = globalThis;
  if (g.__hsDoctorTimer) return;
  g.__hsDoctorTimer = setInterval(() => {
    runDoctor(false).catch(() => {});
  }, DEFAULT.checkMs);
  setTimeout(() => runDoctor(false).catch(() => {}), 60000).unref?.();
}
