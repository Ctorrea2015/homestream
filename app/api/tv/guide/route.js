import { NextResponse } from "next/server";
import { readIptv } from "@/lib/iptv";
import { readEpg, resolveProgrammes } from "@/lib/epg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tv/guide — full guide for the guide page.
 * Returns ALL channels with "now" + "next" programmes from the loaded XMLTV guide.
 * Channels without schedule data still appear (with now:null) — like the
 * live TV page, they're playable even without a published schedule.
 */
export async function GET() {
  const iptv = await readIptv();
  const epg = await readEpg();
  const now = Date.now();

  const channels = iptv.channels.map((c) => {
    const progs = resolveProgrammes(epg, c) || [];
    const nowIdx = progs.findIndex((p) => p[0] <= now && p[1] > now);
    const nowEntry = nowIdx >= 0 ? progs[nowIdx] : progs.find((p) => p[0] > now) || null;
    const nextList = (nowIdx >= 0 ? progs.slice(nowIdx + 1) : []).slice(0, 3);
    const pack = (p) => ({ s: p[0], e: p[1], t: p[2], i: p[3], g: p[4] });
    return {
      name: c.name,
      logo: c.logo || "",
      group: c.group || "",
      url: c.url,
      now: nowEntry ? pack(nowEntry) : null,
      next: nextList.map(pack).slice(0, 2),
    };
  });

  return NextResponse.json({
    fetchedAt: epg.fetchedAt,
    total: iptv.channels.length,
    channels,
  });
}
