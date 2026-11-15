import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /stremio/manifest.json
 * HomeStream as a Stremio-protocol addon — lets Debrify (and Stremio itself)
 * browse this server's library and play everything through the server's
 * engines (library files, torrent engine, converter). The host the client
 * uses rides on the request, so LAN and Tailscale addresses both work.
 */
export async function GET(request) {
  const host = request.headers.get("host") || "localhost:3000";
  return NextResponse.json({
    id: "com.homestream.server",
    version: "1.0.0",
    name: "HomeStream",
    description: `Your HomeStream server (${host}) — library files + server-powered torrent streaming`,
    types: ["movie", "series"],
    resources: ["catalog", "stream", "meta"],
    catalogs: [
      { type: "movie", id: "hs-library", name: "HomeStream Library" },
      { type: "series", id: "hs-library", name: "HomeStream Library" },
    ],
    idPrefixes: ["hs", "tt"],
  });
}
