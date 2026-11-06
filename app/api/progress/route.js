import { NextResponse } from "next/server";
import { readProgress, writeProgress } from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITEMS = 40;
const MIN_POSITION = 15;  // less than this counted as "not started"
const FINISHED_PCT = 0.96;

// GET /api/progress                → recent partial views for the Continue Watching row
// GET /api/progress?id=<itemId>    → one item (for the player to resume)
export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id");
  const data = await readProgress();
  if (id) {
    return NextResponse.json({ item: data.items.find((x) => x.id === id) || null });
  }
  const items = data.items
    .filter((x) => x.position >= MIN_POSITION && x.duration > 60 && x.position / x.duration < FINISHED_PCT)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, MAX_ITEMS);
  return NextResponse.json({ items });
}

// POST /api/progress { id, title, poster, type, position, duration } — save position
export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body?.id || !isFinite(body.position)) {
    return NextResponse.json({ error: "Provide id + position" }, { status: 400 });
  }
  const data = await readProgress();
  const item = {
    id: String(body.id),
    title: String(body.title || "").slice(0, 120),
    poster: String(body.poster || ""),
    type: String(body.type || "movie").slice(0, 20),
    position: Math.round(Number(body.position)),
    duration: Math.round(Number(body.duration) || 0),
    updatedAt: new Date().toISOString(),
  };
  data.items = [item, ...data.items.filter((x) => x.id !== item.id)].slice(0, MAX_ITEMS);
  await writeProgress(data);
  return NextResponse.json({ ok: true });
}

// DELETE /api/progress { id } — finished (or removed from the row)
export async function DELETE(request) {
  const body = await request.json().catch(() => ({}));
  if (!body?.id) return NextResponse.json({ error: "Provide id" }, { status: 400 });
  const data = await readProgress();
  data.items = data.items.filter((x) => x.id !== body.id);
  await writeProgress(data);
  return NextResponse.json({ ok: true });
}
