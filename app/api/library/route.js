import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLibrary, writeLibrary, scanFolder } from "@/lib/videos";
import { refreshAllFolders } from "@/lib/autoscan";
import { enrichVideos } from "@/lib/tmdb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

// GET /api/library -> current library + suggested phone address
export async function GET() {
  const lib = await readLibrary();
  return NextResponse.json({ videos: lib.videos, folders: lib.folders, lanUrl: lanUrl() });
}

// POST /api/library:
//   { folder: "D:\\Movies" }   -> add/scan a folder
//   { action: "refresh" }      -> re-scan every folder (watch folders)
export async function POST(request) {
  const body = await request.json().catch(() => null);

  // ---- Watch-mode: rescan everything, keep posters ----
  if (body?.action === "refresh") {
    const info = await refreshAllFolders({ enrich: true });
    return NextResponse.json(info);
  }

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

// PUT /api/library { removeId } -> remove one video from the library (not the disk file)
export async function PUT(request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.removeId !== "string") {
    return NextResponse.json({ error: "Provide a video id to remove" }, { status: 400 });
  }
  const lib = await readLibrary();
  await writeLibrary({
    folders: lib.folders,
    videos: lib.videos.filter((v) => v.id !== body.removeId),
  });
  return NextResponse.json({ ok: true });
}

// DELETE /api/library { folder: "D:\\Movies" } -> remove folder + its videos
export async function DELETE(request) {
  const body = await request.json().catch(() => null);
  const input = body?.folder;
  if (typeof input !== "string" || !input.trim()) {
    return NextResponse.json({ error: "Provide a folder to remove" }, { status: 400 });
  }
  const root = path.resolve(input.trim());

  const lib = await readLibrary();
  await writeLibrary({
    folders: lib.folders.filter((f) => f !== root),
    videos: lib.videos.filter((v) => v.root !== root),
  });
  return NextResponse.json({ ok: true });
}