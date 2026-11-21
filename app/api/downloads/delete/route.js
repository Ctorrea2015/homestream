import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/downloads  { engine, id, hash }
 * Delete one torrent from its engine (and its files). Used by /downloads ✕.
 */
async function readCfg(name, fallback = {}) {
  try { return JSON.parse(await fs.readFile(path.join(process.cwd(), ".data", name), "utf8")) || fallback; }
  catch { return fallback; }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const engine = String(body.engine || "");
  const id = body.id;
  const hash = String(body.hash || "").toLowerCase();
  const hasId = id !== null && id !== undefined && id !== "";
  if (!/^[a-f0-9]{40}$/.test(hash) && !hasId) {
    return NextResponse.json({ ok: false, error: "Need a full 40-char infoHash or an engine id" }, { status: 400 });
  }

  try {
    if (engine === "Riptide" || engine === "rqbit") {
      const cfg = engine === "Riptide"
        ? await readCfg("riptide.json")
        : await readCfg("rqbit.json", { host: "http://127.0.0.1:3030" });
      const host = cfg?.host?.replace(/\/$/, "");
      if (!host) throw new Error(`${engine} not configured`);
      const key = id !== null && id !== undefined ? id : hash;
      const r = await fetch(`${host}/torrents/${key}/delete`, { method: "POST", signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return NextResponse.json({ ok: true, engine, deleted: key });
    }
    if (engine === "qB") {
      const c = await readCfg("qbittorrent.json");
      const base = (c.host || "").replace(/\/$/, "");
      if (!base) throw new Error("qB not configured");
      let cookie = "";
      const login = await fetch(`${base}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: c.user || "admin", password: c.pass || "" }),
        signal: AbortSignal.timeout(8000),
      });
      if (login.ok) cookie = /SID=[^;]+/.exec(login.headers.get("set-cookie") || "")?.[0] || "";
      const r = await fetch(`${base}/api/v2/torrents/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams({ hashes: hash, deleteFiles: "true" }),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return NextResponse.json({ ok: true, engine, deleted: hash.slice(0, 12) });
    }
    return NextResponse.json({ ok: false, error: `Unknown engine ${engine}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 120) }, { status: 500 });
  }
}
