import { NextResponse } from "next/server";
import { runDoctor } from "@/lib/doctor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/doctor — last report (or run one if none).
 *  POST /api/doctor — run now. { repair: true } performs safe auto-fixes. */
export async function GET(request) {
  const repair = request.nextUrl.searchParams.get("repair") === "1";
  try { return NextResponse.json(repair ? await runDoctor(true) : (await runDoctor(false))); }
  catch (e) { return NextResponse.json({ error: String(e?.message || e).slice(0, 120) }, { status: 500 }); }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try { return NextResponse.json(await runDoctor(Boolean(body.repair))); }
  catch (e) { return NextResponse.json({ error: String(e?.message || e).slice(0, 120) }, { status: 500 }); }
}
