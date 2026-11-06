import { NextResponse } from "next/server";
import { readIptv, writeIptv, parseM3U, mergeSourceData } from "@/lib/iptv";
import { xtreamConnect } from "@/lib/xtream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tv/xtream/refresh { sourceKey }
 *
 * Re-imports a provider's channels using stored credentials. Useful when the
 * importer gained new metadata (e.g. tvg-id capture for EPG matching) after
 * the initial login — no need to re-enter the password in the UI.
 */
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const key = body?.sourceKey;

  const iptv = await readIptv();
  const source = key ? iptv.sources.find((s) => s.key === key) : iptv.sources.find((s) => s.kind === "xtream");
  if (!source) return NextResponse.json({ error: "No Xtream provider source found" }, { status: 404 });
  if (!source.username) return NextResponse.json({ error: "This source has no username stored" }, { status: 400 });
  let password = source.password;
  if (!password && source.epg) {
    // Older imports didn't store the password, but the XmlTV URL carries it.
    try { password = new URL(source.epg).searchParams.get("password"); } catch {}
  }
  if (!password) {
    return NextResponse.json(
      { error: "Credentials aren't stored for this source — click Connect in Provider login to re-import." },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await xtreamConnect(source.host, source.username, password);
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 401 });
  }

  const parsed = parseM3U(result.text);
  if (parsed.length === 0) {
    return NextResponse.json({ error: "Login worked, but the provider returned no channels." }, { status: 400 });
  }

  const out = mergeSourceData(iptv, { ...source, count: parsed.length }, parsed);
  await writeIptv(out);

  const withTvgId = out.channels.filter((c) => c.source === source.key && c.tvgId).length;
  return NextResponse.json({ ok: true, total: out.channels.length, withTvgId, source: source.key });
}
