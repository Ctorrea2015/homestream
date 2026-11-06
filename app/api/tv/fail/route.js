import { NextResponse } from "next/server";
import { readIptv, writeIptv } from "@/lib/iptv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tv/fail { url } -> record this channel as just-failed
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const url = body?.url;
  if (typeof url !== "string") {
    return NextResponse.json({ error: "Provide a channel url" }, { status: 400 });
  }

  const data = await readIptv();
  const meta = { ...(data.meta || {}) };
  const rec = { ...(meta[url] || { failCount: 0 }) };
  rec.lastFail = new Date().toISOString();
  rec.failCount += 1;
  meta[url] = rec;
  await writeIptv({ ...data, meta });

  return NextResponse.json({ ok: true, failCount: rec.failCount });
}
