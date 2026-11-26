/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Fires the watch-folder timer so dropped files appear automatically.
 *
 * The import is deliberately opaque to the bundler (webpackIgnore + a
 * runtime-computed file URL). Webpack compiles instrumentation.js for
 * every runtime, including ones where Node builtins can't be resolved
 * ("Can't resolve 'crypto'" / "Reading from node:crypto is not handled").
 * With webpackIgnore, Node itself loads ./lib/autoscan.js from disk in
 * the nodejs runtime, exactly as written on disk.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis;
  if (g.__hsWatchTimer) return;
  try {
    const cwdUrl =
      "file://" +
      (process.platform === "win32" ? "/" : "") +
      encodeURI(process.cwd().replace(/\\/g, "/"));
    const { startWatchTimer } = await import(/* webpackIgnore: true */ `${cwdUrl}/lib/autoscan.js`);
    startWatchTimer();
    // Disk sweep: hourly cleanup of the torrent scratch folders (rqbit output,
    // qB save paths) so they can't fill the disk again (two disk-full incidents).
    const { startDiskSweep } = await import(/* webpackIgnore: true */ `${cwdUrl}/lib/diskSweep.js`);
    startDiskSweep();
    // rqbit watchdog: detects a frozen rqbit daemon (answers reads, hangs on
    // adds — Engine 1 silently dies and everything falls to qB) and restarts
    // it in place, no reboot needed.
    const { startRqbitWatchdog } = await import(/* webpackIgnore: true */ `${cwdUrl}/lib/rqbitWatchdog.js`);
    startRqbitWatchdog();
    // Doctor: periodic health check tying together the watchdogs; reports
    // to /api/doctor, auto-fixes only safe runtime state (no code changes).
    const { startDoctor } = await import(/* webpackIgnore: true */ `${cwdUrl}/lib/doctor.js`);
    startDoctor();
  } catch {
    // The app still works fully manually if this fails.
  }
}
