import { NextResponse } from "next/server";

/**
 * CORS for the /stremio addon surface — what the official Stremio SDK sets
 * for you. Stremio's *web* client runs in a browser and enforces CORS on
 * addon requests; native clients (Debrify, mobile Stremio) don't check, but
 * the headers cost nothing and make the addon work in every client.
 */
export function middleware(request) {
  const res = NextResponse.next();
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Range");
  res.headers.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  return res;
}

export const config = {
  matcher: "/stremio/:path*",
};
