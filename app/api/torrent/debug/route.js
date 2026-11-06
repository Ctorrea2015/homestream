import { NextResponse } from "next/server";
import { getTorrent, pickVideoFile } from "@/lib/torrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/torrent/debug?infoHash=... — inspect the engine's state (fix tool). */
export async function GET(request) {
  const infoHash = ((new URL(request.url).searchParams.get("infoHash")) || "").toLowerCase();
  const nameHint = new URL(request.url).searchParams.get("name") || "";
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    return NextResponse.json({ error: "Provide infoHash" }, { status: 400 });
  }

  // Fire and forget — keep the engine working while we report
  let details = { note: "adding…" };
  const held = getTorrent(infoHash, 120000).then(async (t) => {
    const pick = pickVideoFile(t, nameHint);
    details = {
      ready: t.ready,
      metadata: Boolean(t.metadata),
      peers: t.numPeers,
      progress: Number((t.progress || 0).toFixed(3)),
      files: t.files.map((f) => `${f.name} (${(f.length / 1e9).toFixed(2)} GB)`),
      pick: pick ? pick.file.name : null,
      downloadSpeed: (t.downloadSpeed / 1e6).toFixed(2) + " MB/s",
    };
  }).catch((err) => {
    details = { error: err?.message || String(err) };
  });

  // give it a short moment so the first debug call shows progress
  await new Promise((r) => setTimeout(r, 3000));

  const s = globalThis.__hsTorrent;
  return NextResponse.json({
    clientExists: Boolean(s?.client),
    torrents: s?.client?.torrents?.length || 0,
    thisTorrent: details,
  });
}
