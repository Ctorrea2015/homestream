import { NextResponse } from "next/server";
import { readAddons } from "@/lib/addons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stremio extra-args go before ".json": /catalog/movie/top/search=batman.json */
function catalogUrl(addon, type, catId, extras = "") {
  const base = `${addon.url}/catalog/${type}/${encodeURIComponent(catId)}`;
  return extras ? `${base}/${extras}.json` : `${base}.json`;
}

/**
 * GET /api/addons/search?q=batman&type=movie
 * Searches every installed addon (those that offer that type) and returns
 * a merged poster list, newest addons first. Addons that don't support
 * search are skipped silently.
 */
/**
 * GET /api/addons/search?q=Suits[&type=movie|series]
 * Searches every installed addon. When `type` is omitted, BOTH movie and
 * series are searched and merged (so TV shows actually show up when you
 * search their names).
 */

// tiny per-query cache:slash backspace-and-retype hits answer instantly
const searchCache = new Map();

export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const q = (p.get("q") || "").trim();
  const type = (p.get("type") || "").replace(/[^a-z]/gi, "");
  if (!q) return NextResponse.json({ metas: [] });
  const wanted = type ? [type] : ["movie", "series"];

  const addons = await readAddons();
  const encoded = encodeURIComponent(q.slice(0, 80));

  // Server-side cache — repeat searches (retyping, backspacing) answer instantly.
  const cacheKey = `${encoded}|${wanted.join(",")}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return NextResponse.json({ metas: cached.metas });

  // One attempt per addon per type: the `search` catalog IS the search
  // endpoint. Asking additional catalogs for the same query returned near
  // duplicates and multiplied the wall-clock time for nothing.
  const attempts = [];
  for (const t of wanted) {
    const usable = addons.filter((a) => a.types.includes(t) || a.types.includes("all") || a.types.length === 0);
    for (const addon of usable) attempts.push({ addon, t });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const proms = attempts.map(({ addon, t }) =>
    fetch(catalogUrl(addon, t, "search", `search=${encoded}`), {
      headers: { "User-Agent": "HomeStream/1.0" },
      signal: AbortSignal.timeout(8000),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
  );

  const seen = new Set();
  const metas = [];
  const pushMetas = (j) => {
    if (!j?.metas) return false;
    for (const m of j.metas) {
      const key = `${m.id}|${m.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      metas.push({
        id: String(m.id),
        type: m.type || wanted[0],
        name: m.name || "",
        poster: m.poster || "",
        year: m.releaseInfo ? String(m.releaseInfo).match(/\d{4}/)?.[0] : "",
        rating: m.imdbRating || m.rating || null,
        description: m.description || "",
      });
      if (metas.length >= 120) break;
    }
    return metas.length >= 120;
  };

  // Don't wait for every straggler addon: answer as soon as we have a good
  // poster list. Fast addons (Cinemeta) answer in ~1s; one slow host used
  // to pin the whole search for 8s. Poll in small steps and stop early.
  const started = Date.now();
  const allSettled = Promise.allSettled(proms);
  let full = false;
  const ingest = proms.map((p, i) =>
    p.then((j) => {
      if (full) return;
      if (pushMetas(j)) full = true;
    })
  );
  while (Date.now() - started < 8000) {
    const all = await Promise.race([allSettled, sleep(400)]);
    if (metas.length >= 12 && Date.now() - started >= 2200) break;
    if (all) break; // every addon answered
  }
  // give any in-flight ingests one last moment to append
  await Promise.race([Promise.all(ingest), sleep(600)]);
  full = true;

  // trim cache memory (a Map entry is tiny, but keep it bounded anyway)
  if (searchCache.size > 100) searchCache.clear();
  searchCache.set(cacheKey, { at: Date.now(), metas });
  return NextResponse.json({ metas });
}
