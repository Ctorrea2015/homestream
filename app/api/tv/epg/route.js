import { NextResponse } from "next/server";
import { readIptv } from "@/lib/iptv";
import { readEpg, writeEpg, createXmltvParser, buildFuzzyIndex, resolveProgrammes } from "@/lib/epg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GUIDE_WINDOW_HOURS = 26; // keep ~now − 2h to now + 24h

// PUT /api/tv/epg { sourceKey? } — fetch + parse the provider's XmlTV guide
export async function PUT(request) {
  const body = await request.json().catch(() => ({}));
  const iptv = await readIptv();

  const source = body?.sourceKey
    ? iptv.sources.find((s) => s.key === body.sourceKey)
    : iptv.sources.find((s) => s.epg);
  if (!source) return NextResponse.json({ error: "No provider with guide data — connect via Provider login first" }, { status: 400 });
  if (!source.epg) return NextResponse.json({ error: "This source has no EPG XMLTV URL" }, { status: 400 });

  const now = Date.now();
  const programmes = {};
  let count = 0;
  const onProgramme = (p) => {
    const list = programmes[p.id] || (programmes[p.id] = []);
    list.push([p.s, p.e, p.t, p.i || "", p.g || ""]);
    count += 1;
  };
  const parser = createXmltvParser(now - 2 * 3600e3, now + (GUIDE_WINDOW_HOURS - 2) * 3600e3, onProgramme);
  let res;
  try {
    res = await fetch(source.epg, {
      headers: { "User-Agent": "HomeStream/1.0 VLC/3.0" },
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    return NextResponse.json({ error: `Guide download failed: ${err?.message || String(err)}` }, { status: 400 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: `Guide download failed: HTTP ${res.status}` }, { status: 400 });
  }
  if (!res.body) {
    return NextResponse.json({ error: "Provider returned an empty guide" }, { status: 400 });
  }

  // Stream the XML through the chunk parser (memory-safe for huge guides)
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let streamNote = null;
  try {
    while (!done) {
      const { done: d, value } = await reader.read();
      done = d;
      if (value) parser.feed(decoder.decode(value, { stream: !done }));
    }
  } catch (err) {
    streamNote = `stream error: ${err?.message || String(err)}`; // keep partial guide
  }

  // sort each channel's programmes by start time
  for (const chId of Object.keys(programmes)) {
    programmes[chId].sort((a, b) => a[0] - b[0]);
  }

  await writeEpg({
    fetchedAt: new Date().toISOString(),
    programmes,
    nameToId: parser.nameToId,
    fuzzyIndex: buildFuzzyIndex(parser.rawNames || parser.nameToId),
  });
  return NextResponse.json({
    ok: true,
    channels: Object.keys(programmes).length,
    programmes: count,
    note: streamNote || undefined,
  });
}

/** Resolve a channel (by url or name) to its XMLTV programme list. */
function resolveChannelProg(epg, iptv, url, name) {
  let ch = null;
  if (url) ch = iptv.channels.find((c) => c.url === url);
  if (!ch && name) ch = { name };
  return resolveProgrammes(epg, ch);
}

// GET /api/tv/epg?u=<channel url> → what's now + next on that channel
export async function GET(request) {
  const urlP = new URL(request.url).searchParams;
  const url = urlP.get("u");
  const name = urlP.get("name");
  if (!url && !name) return NextResponse.json({ error: "Provide a channel url (?u=) or name (?name=)" }, { status: 400 });

  const epg = await readEpg();
  if (!epg.fetchedAt) return NextResponse.json({ error: "No guide loaded — press “Update TV guide”" }, { status: 404 });

  const iptv = await readIptv();
  const ch = (url && iptv.channels.find((c) => c.url === url)) || (name ? { name } : null);
  const progs = resolveProgrammes(epg, ch);
  if (!progs) return NextResponse.json({ now: null, next: [], reason: "No schedule data for this channel" });

  const now = Date.now();
  const nowIndex = progs.findIndex((p) => p[0] <= now && p[1] > now);
  const nowEntry = nowIndex >= 0 ? progs[nowIndex] : null;
  const nextList = (nowIndex >= 0 ? progs.slice(nowIndex + 1) : progs.filter((p) => p[0] > now)).slice(0, 6);

  const pack = (p) => ({ s: p[0], e: p[1], t: p[2], i: p[3], g: p[4] });
  return NextResponse.json({
    fetchedAt: epg.fetchedAt,
    now: nowEntry ? pack(nowEntry) : { s: null, e: null, t: "No programme listed", i: "", g: "" },
    next: nextList.map(pack),
  });
}

// POST /api/tv/epg { urls: [...] } → { <url>: "nowTitle" } for card badges
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const urls = Array.isArray(body?.urls) ? body.urls.slice(0, 500) : [];
  if (urls.length === 0) return NextResponse.json({});

  const epg = await readEpg();
  if (!epg.fetchedAt) return NextResponse.json({});

  const iptv = await readIptv();
  const byUrl = new Map(iptv.channels.map((c) => [c.url, c]));
  const nowTitles = {};

  const now = Date.now();
  for (const u of urls) {
    const ch = byUrl.get(u);
    if (!ch) continue;
    const progs = resolveProgrammes(epg, ch);
    if (!progs || progs.length === 0) continue;
    const cur = progs.find((p) => p[0] <= now && p[1] > now);
    nowTitles[u] = cur ? cur[2] : null;
  }
  return NextResponse.json(nowTitles);
}
