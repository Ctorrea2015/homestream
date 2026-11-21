import { NextResponse } from "next/server";
import { readIptv, writeIptv, parseM3U, mergeSourceData } from "@/lib/iptv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/tv/import-text { text } — import a pasted M3U playlist. */
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const text = String(body?.text || "");
  if (text.length < 20) return NextResponse.json({ error: "Paste a full M3U playlist" }, { status: 400 });
  const parsed = parseM3U(text);
  if (!parsed.length) return NextResponse.json({ error: "No channels found in that M3U" }, { status: 400 });
  const data = await readIptv();
  const key = `pasted:${Date.now()}`;
  const out = mergeSourceData(data, { key, source: key, isUrl: false }, parsed);
  await writeIptv(out);
  return NextResponse.json({ ok: true, added: parsed.length, total: out.channels.length });
}
