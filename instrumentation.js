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
  } catch {
    // The app still works fully manually if this fails.
  }
}
