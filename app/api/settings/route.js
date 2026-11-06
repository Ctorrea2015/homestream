import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getTmdbKey, setTmdbKey } from "@/lib/tmdb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// App data directory (used by library and tmdb modules).
export const DATA_DIR = path.join(process.cwd(), ".data");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

/** Address of this PC on the LAN, so phones can connect (same Wi-Fi). */
function lanUrl() {
  let ip = null;
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) {
      if (net.family === "IPv4" && !net.internal && !ip) ip = net.address;
    }
  }
  return ip ? `http://${ip}:3000` : null;
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// GET /api/settings -> { tmdbKey, networkSetup }
export async function GET() {
  try {
    const s = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"));
    return NextResponse.json({ tmdbKey: s.tmdbKey || "", networkSetup: s.networkSetup || false });
  } catch {
    return NextResponse.json({ tmdbKey: "", networkSetup: false });
  }
}

// POST /api/settings {
//   tmdbKey: "..."       -> validate & save TMDB key
//   action: "setup-network"  -> save LAN IP for auto-discovery
// }
export async function POST(request) {
  const body = await request.json().catch(() => null);

  // ---- TMDB key save with validation ----
  if (body?.tmdbKey) {
    const key = body.tmdbKey.trim();
    if (!key) return NextResponse.json({ error: "Paste your TMDB API key (v3)" }, { status: 400 });

    // Validate against TMDB before saving
    try {
      const res = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) {
        return NextResponse.json({ error: "TMDB rejected that key — make sure you copied the “API Key (v3)”" }, { status: 400 });
      }
      if (!res.ok) {
        return NextResponse.json({ error: `TMDB check failed (HTTP ${res.status})` }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Couldn't reach TMDB to verify the key" }, { status: 502 });
    }

    await setTmdbKey(key);
    return NextResponse.json({ ok: true });
  }

  // ---- Network setup save ----
  if (body?.action === "setup-network") {
    const ip = body.ip || "";
    if (!ip) return NextResponse.json({ error: "No IP provided" }, { status: 400 });

    let s = {};
    try { s = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")); } catch {}
    s.networkSetup = true;
    s.lanIp = ip;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf8");
    return NextResponse.json({ ok: true, lanIp: ip });
  }

  // ---- Original: folder scan ----
  const input = body?.folder;
  if (typeof input !== "string" || !input.trim()) {
    return NextResponse.json({ error: "Provide a folder path, e.g. D:\\Movies" }, { status: 400 });
  }

  const root = path.resolve(input.trim());
  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    return NextResponse.json({ error: `Folder not found or unreadable: ${root}` }, { status: 400 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: `${root} is a file, not a folder` }, { status: 400 });
  }

  const scanned = await scanFolder(root);

  const lib = await readLibrary();
  // Keep videos from other folders that still exist; replace this folder's
  // entries with the fresh scan (handles renamed/deleted files).
  const others = lib.videos.filter((v) => v.root !== root);
  const kept = [];
  for (const v of others) if (await fileExists(v.path)) kept.push(v);

  // Carry over posters already fetched for files still present here.
  const knownMeta = new Map(lib.videos.filter((v) => v.root === root && v.meta).map((v) => [v.id, v.meta]));
  for (const v of scanned) {
    const meta = knownMeta.get(v.id);
    if (meta) v.meta = meta;
  }

  // Fetch posters for new files (limited per call; the watch timer finishes later).
  let enrichInfo = { enriched: 0 };
  try {
    enrichInfo = await enrichVideos(scanned, 25);
  } catch {}

  const videos = [...kept, ...scanned].map((v) => ({ ...v, meta: v.meta ?? null }));
  const folders = [...new Set([...lib.folders, root])];

  await writeLibrary({ folders, videos });
  return NextResponse.json({ added: scanned.length, total: videos.length, folder: root, enriched: enrichInfo.enriched });
}