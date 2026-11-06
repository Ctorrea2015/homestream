/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Fires the watch-folder timer so dropped files appear automatically.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis;
  if (g.__hsWatchTimer) return;
  try {
    const { startWatchTimer } = await import("./lib/autoscan.js");
    startWatchTimer();
  } catch {
    // The app still works fully manually if this fails.
  }
}
