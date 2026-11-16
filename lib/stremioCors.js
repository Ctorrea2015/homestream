/**
 * CORS for the /stremio addon surface — what the official SDK sets for you.
 * Stremio's *web* client runs in a browser and enforces CORS on addon
 * requests; native clients (Debrify, mobile Stremio) don't check, but the
 * headers cost nothing and make the addon work everywhere.
 */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

/** Attach CORS headers to a NextResponse. */
export function withCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

/** Shared OPTIONS preflight handler for /stremio routes. */
export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
