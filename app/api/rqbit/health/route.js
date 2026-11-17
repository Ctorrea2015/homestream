import { NextResponse } from "next/server";
import { watchdogPass } from "@/lib/rqbitWatchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/rqbit/health — watchdog state (last probe, recoveries).
 * POST /api/rqbit/health — run a probe right now (auto-recovers if frozen).
 */
export async function GET() {
  const st = globalThis.__hsRqbitWatchdog || null;
  return NextResponse.json({
    timer: Boolean(globalThis.__hsRqbitWatchdogTimer),
    lastProbe: st?.lastProbe || null,
    lastRecovery: st?.lastRecovery || null,
    restarts: st?.restarts || 0,
  });
}

export async function POST() {
  try {
    return NextResponse.json({ ok: true, ...(await watchdogPass()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 120) }, { status: 500 });
  }
}
