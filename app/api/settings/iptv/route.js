import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/settings/iptv { host, username, password } — save an Xtream
 * login into the source list that lib/iptvHandler.js reads, then sync.
 */
export async function POST(request) {
  const b = await request.json().catch(() => ({}));
  const host = String(b.host || "").trim().replace(/\/$/, "");
  const username = String(b.username || "").trim();
  const password = String(b.password || "").trim();
  if (!host || !username || !password) {
    return NextResponse.json({ error: "Host, username and password required" }, { status: 400 });
  }
  const file = path.join(process.cwd(), ".data", "iptv.json");
  let data = { sources: [], channels: [] };
  try { data = JSON.parse(await fs.readFile(file, "utf8")) || data; } catch {}
  const sources = (data.sources || []).filter((s) => !(s.kind === "xtream" && s.host === host && s.username === username));
  sources.push({ kind: "xtream", host, username, password, key: `xtream:${host}/${username}` });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...data, sources }, null, 2), "utf8");

  // Sync the SQLite cache so the app's Live TV list fills immediately.
  try {
    const { syncAll } = await import("@/lib/iptvHandler");
    const stats = await syncAll({ skipEpg: true });
    return NextResponse.json({ ok: true, stats });
  } catch (e) {
    return NextResponse.json({ ok: true, warning: `saved; sync failed: ${String(e?.message || e).slice(0, 80)}` });
  }
}
