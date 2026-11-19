import { NextResponse } from "next/server";
import { GET as resolve } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/torrent/resolve/play?id=tt1234567&type=movie[&s=1&e=1]
 *
 * Debrify-facing counterpart to /api/torrent/resolve: runs the exact same
 * resolve flow (rank addon sources → load the best into rqbit) and then
 * 302-redirects the player straight to the returned /api/torrent/stream URL.
 *
 * The Stremio stream list puts this behind a "⚡ Auto" entry. By the time a
 * user taps it, the normal pre-warm has already loaded the same torrent, so
 * the resolve inside this redirect is instant — libmpv follows the 302 and
 * plays the top-ranked source directly from rqbit, no source-picking needed.
 */
export async function GET(request) {
  const resolved = await resolve(request);
  if (!resolved.ok) return resolved; // pass through 400 / 404 / 502 JSON errors
  const data = await resolved.json().catch(() => null);
  if (!data?.streamUrl) {
    return NextResponse.json({ ok: false, error: "Resolver returned no stream URL" }, { status: 502 });
  }
  return NextResponse.redirect(data.streamUrl, { status: 302 });
}
