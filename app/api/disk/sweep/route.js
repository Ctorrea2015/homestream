import { NextResponse } from "next/server";
import { sweepOnce } from "@/lib/diskSweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/disk/sweep — last sweep summary + the timer's state.
 * POST /api/disk/sweep — run a sweep right now (returns the same summary).
 */
export async function GET() {
  const st = globalThis.__hsSweepState || null;
  return NextResponse.json({ last: st?.last || null, running: Boolean(st?.running), timer: Boolean(globalThis.__hsSweepTimer) });
}

export async function POST() {
  const st = globalThis.__hsSweepState;
  if (st?.running) return NextResponse.json({ ok: true, note: "sweep already running", last: st.last });
  try {
    const summary = await sweepOnce();
    if (st) st.last = { at: new Date().toISOString(), ...summary };
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 120) }, { status: 500 });
  }
}
