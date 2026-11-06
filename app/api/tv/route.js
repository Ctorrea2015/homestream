import { NextResponse } from "next/server";
import path from "node:path";
import { readIptv, writeIptv, parseM3U, loadPlaylist, mergeSourceData } from "@/lib/iptv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tv -> sources + channels
export async function GET() {
  const data = await readIptv();
  return NextResponse.json(data);
}

// POST /api/tv { source: "https://.../playlist.m3u" or a local file path }
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const source = body?.source;
  if (typeof source !== "string" || !source.trim()) {
    return NextResponse.json({ error: "Provide an M3U playlist URL or file path" }, { status: 400 });
  }

  let text;
  try {
    text = await loadPlaylist(source.trim());
  } catch (err) {
    if (err?.code === "ENOENT") {
      return NextResponse.json({ error: `File not found: ${source}` }, { status: 400 });
    }
    return NextResponse.json({ error: err?.message || String(err) }, { status: 400 });
  }

  const parsed = parseM3U(text);
  if (parsed.length === 0) {
    return NextResponse.json({ error: "No channels found — is this a valid M3U playlist?" }, { status: 400 });
  }

  const data = await readIptv();
  const isUrl = /^https?:\/\//i.test(source);
  const key = isUrl ? source.trim().toLowerCase() : path.resolve(source.trim());

  const out = mergeSourceData(data, { key, source: source.trim(), isUrl }, parsed);
  await writeIptv(out);
  return NextResponse.json({ added: parsed.length, total: out.channels.length });
}

// DELETE /api/tv { key? } -> remove one source, or clear everything
export async function DELETE(request) {
  const body = await request.json().catch(() => null);
  const data = await readIptv();

  if (body?.key) {
    return writeResponse(await removeSource(data, body.key));
  }
  await writeIptv({ sources: [], channels: [] });
  return NextResponse.json({ ok: true });
}

async function removeSource(data, key) {
  const sources = data.sources.filter((s) => s.key !== key);
  const channels = data.channels.filter((c) => c.source !== key);
  await writeIptv({ sources, channels });
  return { ok: true };
}

function writeResponse(value) {
  return NextResponse.json(value);
}
