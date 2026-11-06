import { NextResponse } from "next/server";
import { readIptv, writeIptv, parseM3U, mergeSourceData } from "@/lib/iptv";
import { normalizeHost, xtreamConnect } from "@/lib/xtream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tv/xtream { host, username, password }
 *
 * Xtream Codes provider login: validates credentials, pulls the provider's
 * full m3u_plus playlist (names, logos, categories) and imports it as a
 * source. Reconnecting the same provider replaces its channels.
 */
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const host = normalizeHost(body?.host);

  if (!host) return NextResponse.json({ error: "Enter your provider's server address, e.g. http://provider.tv:8080" }, { status: 400 });
  if (!username || !password) return NextResponse.json({ error: "Enter the username and password from your provider" }, { status: 400 });

  let result;
  try {
    result = await xtreamConnect(host, username, password);
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 401 });
  }

  const parsed = parseM3U(result.text);
  if (parsed.length === 0) {
    return NextResponse.json({ error: "Login worked, but this provider returned no channels. (Their playlist URL may be disabled.)" }, { status: 400 });
  }

  const data = await readIptv();
  const key = `xtream:${host}/${encodeURIComponent(username)}`;
  const out = mergeSourceData(
    data,
    { key, kind: "xtream", host, username, password, isUrl: true, display: `${host} — ${username}`, epg: result.epg },
    parsed,
  );
  await writeIptv(out);

  return NextResponse.json({
    added: parsed.length,
    total: out.channels.length,
    source: out.sources.find((s) => s.key === key),
  });
}
