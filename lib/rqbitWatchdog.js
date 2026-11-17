import fs from "node:fs/promises";
import path from "node:path";
import { exec, spawn } from "node:child_process";
// Relative + explicit .js: this module is imported RAW from disk by
// instrumentation.js (webpackIgnore), where "@/..." aliases and extensionless
// relatives don't resolve (the diskSweep lesson).
import { lastStreamTouch, touchedHashes } from "./idleTorrents.js";

/**
 * rqbit watchdog — self-heals a frozen rqbit daemon.
 *
 * Diagnosis, 2026-11-17: rqbit wedged on the Pi — it kept answering cheap
 * reads (GET /torrents) but hung forever on the add path, so Engine 1 timed
 * out on EVERY torrent and everything silently fell to qBittorrent. Only a
 * full reboot fixed it.
 *
 * The canary: an empty-body POST to /torrents. A healthy daemon rejects it
 * instantly (HTTP 400 — decode error, no swarm work involved); a wedged
 * daemon hangs on it because the hang lives in the add/session machinery.
 * Never use a real magnet as the probe — healthy rqbit BLOCKS add requests
 * until metadata resolves, which would false-positive on slow swarms.
 *
 * On a hang: kill the rqbit process and relaunch it with the same command
 * line (server and rqbit run as the same user, so no sudo needed), then
 * verify with a second probe.
 *
 * Config (optional): .data/rqbit-watchdog.json
 *   { "cmd": "/usr/local/bin/rqbit", "args": [...], "kill": "pkill -f …",
 *     "checkMs": 300000, "probeTimeoutMs": 8000, "host": "http://127.0.0.1:3030" }
 */

const DEFAULTS = {
  linux: {
    // The Pi's actual launch line (ps aux): /usr/local/bin/rqbit --http-api-listen-addr
    // 0.0.0.0:3030 server start /home/ctorres19956/torrents --persistence-location /home/ctorres19956/.rqbit
    cmd: "/usr/local/bin/rqbit",
    args: ["--http-api-listen-addr", "0.0.0.0:3030", "server", "start", "/home/ctorres19956/torrents", "--persistence-location", "/home/ctorres19956/.rqbit"],
    kill: "pkill -f /usr/local/bin/rqbit",
    host: "http://127.0.0.1:3030",
  },
  win32: {
    cmd: path.join(process.cwd(), "bin", "rqbit.exe"),
    args: ["server", "start", path.join(process.cwd(), ".data", "rqbit-downloads"), "--persistence-location", path.join(process.cwd(), ".data", "rqbit-session")],
    kill: "taskkill /F /IM rqbit.exe",
    host: "http://127.0.0.1:3030",
  },
};

async function loadCfg() {
  const def = DEFAULTS[process.platform] || null;
  if (!def) return null; // unsupported platform — watchdog disabled
  let extra = {};
  try { extra = JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", "rqbit-watchdog.json"), "utf8")) || {}; } catch {}
  return {
    checkMs: 5 * 60 * 1000,
    probeTimeoutMs: 8000,
    restartCooldownMs: 10 * 60 * 1000,
    ...def,
    ...extra,
  };
}

/** One canary probe. Returns { alive: bool, detail: string } — never throws. */
async function probe(host, timeoutMs) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${host}/torrents?overwrite=true`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.text().catch(() => "");
    // ANY answer means the add machinery still responds (400 expected).
    return { alive: true, detail: `HTTP ${res.status} in ${Date.now() - t0}ms` };
  } catch {
    return { alive: false, detail: `no answer after ${timeoutMs}ms` };
  }
}

function sh(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: 15000 }, (err, so, se) => resolve({ err, out: `${so}${se}`.slice(0, 100) }));
  });
}

/** Kill + relaunch + verify. Returns a summary string. */
async function recover(cfg) {
  console.error("[rqbit-watchdog] daemon FROZEN — killing and relaunching…");
  const killed = await sh(cfg.kill);
  await new Promise((r) => setTimeout(r, 3000));
  try {
    spawn(cfg.cmd, cfg.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (e) {
    return `relaunch failed: ${String(e).slice(0, 80)}`;
  }
  await new Promise((r) => setTimeout(r, 12000));
  const after = await probe(cfg.host, cfg.probeTimeoutMs);
  console.error(`[rqbit-watchdog] relaunched — probe after restart: ${after.alive ? "ALIVE" : "STILL FROZEN"} (${after.detail}) ${killed.out}`);
  return after.alive ? "recovered" : "relaunched but still frozen";
}

/** Run one watchdog pass (probe → recover if frozen). Returns a summary. */
export async function watchdogPass() {
  const cfg = await loadCfg();
  if (!cfg) return { disabled: true, reason: `unsupported platform ${process.platform}` };
  const g = globalThis;
  const st = (g.__hsRqbitWatchdog ||= { lastProbe: null, lastRecovery: null, recovering: false, restarts: 0, hungStreak: 0 });

  if (st.recovering) return { note: "recovery in progress" };
  const result = await probe(cfg.host, cfg.probeTimeoutMs);
  st.lastProbe = { at: new Date().toISOString(), ...result };
  if (result.alive) {
    st.hungStreak = 0;
    return { alive: true, detail: result.detail };
  }

  // Referee 1 — never kill while someone is watching. A frozen-looking
  // probe can also happen when the add path holds the session lock during
  // legitimate metadata resolution (weak swarm); killing then would drop
  // every active stream. The liveness ledger knows who is reading.
  const WATCHING_MS = 5 * 60 * 1000;
  // Any torrent touched recently = someone watching (ledger is keyed by
  // infoHash, so scan the touched set via a fresh probe of recency).
  let watching = false;
  try {
    watching = touchedHashes().some((h) => {
      const at = lastStreamTouch(h);
      return at && Date.now() - at < WATCHING_MS;
    });
  } catch {}
  if (watching) {
    st.hungStreak = 0; // can't judge reliably mid-watch; reset
    return { alive: false, note: "probe hung, but a stream was read in the last 5 min — not restarting while someone is watching" };
  }

  // Referee 2 — require TWO consecutive hung probes. One hang can be a
  // transient stall; two in a row (10 min apart on the 5-min timer) is a
  // wedge. st.hungStreak persists across passes.
  st.hungStreak += 1;
  if (st.hungStreak < 2) {
    return { alive: false, note: "first hung probe — waiting for a second consecutive one before killing the daemon" };
  }

  if (st.lastRecovery && Date.now() - st.lastRecovery.at < cfg.restartCooldownMs) {
    return { alive: false, note: "frozen but in cooldown — not restarting again yet" };
  }
  st.recovering = true;
  try {
    st.lastRecovery = { at: new Date().toISOString(), action: await recover(cfg) };
    st.restarts += 1;
    st.hungStreak = 0;
  } finally {
    st.recovering = false;
  }
  return { alive: false, action: st.lastRecovery.action };
}

/** Start the timer — idempotent, safe to call from instrumentation. */
export function startRqbitWatchdog() {
  const g = globalThis;
  if (g.__hsRqbitWatchdogTimer) return;
  g.__hsRqbitWatchdog = { lastProbe: null, lastRecovery: null, recovering: false, restarts: 0 };
  const run = async () => {
    const st = g.__hsRqbitWatchdog;
    if (st.recovering) return;
    try { await watchdogPass(); } catch (e) { console.error("[rqbit-watchdog] pass failed:", String(e).slice(0, 100)); }
  };
  // First check ~2 min after boot (daemon had time to come up), then every 5 min.
  g.__hsRqbitWatchdogTimer = setInterval(run, 5 * 60 * 1000);
  setTimeout(run, 2 * 60 * 1000).unref?.();
}
