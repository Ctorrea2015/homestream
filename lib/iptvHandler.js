/**
 * HomeStream IPTV Handler — SQLite-backed Xtream Codes module.
 *
 * Owns a local SQLite database (.data/iptv-cache.db) that caches
 *   • live channel categories       (table categories)
 *   • live channels + stream URLs   (table channels)
 *   • the XMLTV program guide / EPG (table programmes)
 *
 * Credentials are reused from the provider logins already saved by the
 * existing Xtream importer (.data/iptv.json, sources with kind:"xtream") —
 * there is deliberately no second place to enter them.
 *
 * Public API:
 *   syncAll()                 — fetch + cache categories/channels/EPG
 *   getChannel(numericId)     — one cached channel by Xtream stream id
 *   listChannels(categoryId?) — cached channel list (fast, from SQLite)
 *   listCategories()          — cached category list
 *   streamUrlFor(id)          — build the provider /live/u/p/<id>.m3u8 URL
 *   dbStatus()                — row counts + last sync time
 */
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { readIptv } from "@/lib/iptv";
import { xmltvTime } from "@/lib/epg";

const DB_PATH = path.join(process.cwd(), ".data", "iptv-cache.db");
const UA = "HomeStream/1.0 VLC/3.0";

let db = null;
function getDb() {
  if (db) return db;
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      source  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      numericId   TEXT PRIMARY KEY,          -- Xtream stream id → /live/:id
      name        TEXT NOT NULL,
      logo        TEXT,
      categoryId  TEXT,
      url         TEXT NOT NULL,             -- concrete stream url (playlist or built)
      tvgId       TEXT,                      -- guide mapping (epg_channel_id)
      source      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS programmes (
      tvgId TEXT NOT NULL,
      title TEXT NOT NULL,
      start INTEGER NOT NULL,                -- epoch ms
      stop  INTEGER NOT NULL,
      PRIMARY KEY (tvgId, start)
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX IF NOT EXISTS idx_channels_cat  ON channels(categoryId);
    CREATE INDEX IF NOT EXISTS idx_prog_channel ON programmes(tvgId, start);
  `);
  db = d;
  return d;
}

/* ------------------------------ credentials ------------------------------ */

async function xtreamProviders() {
  const data = await readIptv();
  return (data.sources || []).filter(
    (s) => s.kind === "xtream" && s.host && s.username && s.password,
  );
}

function xtreamApi(provider, action) {
  const u = encodeURIComponent(provider.username);
  const p = encodeURIComponent(provider.password);
  return `${provider.host}/player_api.php?username=${u}&password=${p}&action=${action}`;
}

async function apiJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Provider API HTTP ${res.status}`);
  return res.json();
}

/** Extract the numeric Xtream stream id from a playlist URL .../live/u/p/123.m3u8 */
export function numericIdFromUrl(url) {
  const m = /\/live\/[^/]+\/[^/]+\/(\d+)(?:\.\w+)?$/i.exec(url || "");
  if (m) return m[1];
  const fallback = /(\d{4,})(?:\.m3u8|\.ts)?$/i.exec((url || "").split("?")[0]);
  return fallback ? fallback[1] : null;
}

/* --------------------------------- sync ---------------------------------- */

let syncing = null; // in-flight promise (avoid parallel full syncs)

export function syncAll({ skipEpg = false } = {}) {
  if (!syncing) syncing = doSync({ skipEpg }).finally(() => (syncing = null));
  return syncing;
}

async function fetchXmltv(epgUrl) {
  const res = await fetch(epgUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`XMLTV HTTP ${res.status}`);
  return res.text();
}

function parseXmltvProgrammes(xml, knownSet) {
  // Memory-lean: filter while scanning (keep only programmes for cached
  // channels) and hard-cap the row count — the full parse could exhaust the
  // RAM on small devices (Raspberry Pi) and crash the server mid-response.
  const out = [];
  const CAP = 120000;
  const rx = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let m;
  while ((m = rx.exec(xml)) && out.length < CAP) {
    const attrs = m[1];
    const ch = ((/(?:^|\s)channel="([^"]*)"/.exec(attrs) || [])[1] || "").trim();
    if (!ch || !knownSet.has(ch.toLowerCase())) continue; // rejected early = less RAM
    const block = m[2];
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block) || [])[1] || "";
    if (!title) continue;
    // start=/stop= live in the opening <programme …> attributes
    const start = xmltvTime((/start="([^"]*)"/.exec(attrs) || [])[1]);
    const stop = xmltvTime((/stop="([^"]*)"/.exec(attrs) || [])[1]);
    if (!Number.isFinite(start) || !(stop > start)) continue;
    out.push({ tvgId: ch, title: title.replace(/\s+/g, " ").trim(), start, stop });
  }
  return out;
}

async function doSync({ skipEpg = false } = {}) {
  const providers = await xtreamProviders();
  if (!providers.length) throw new Error("No Xtream provider is saved yet — log in on the /tv page first.");

  const d = getDb();
  const stats = [];

  for (const provider of providers) {
    const src = `${provider.host}/${provider.username}`;
    let added = 0, epgRows = 0, updates = [];

    // 1) categories ----------------------------------------------------------
    let cats = [];
    try {
      cats = await apiJson(xtreamApi(provider, "get_live_categories"));
      if (!Array.isArray(cats)) cats = [];
    } catch { cats = []; } // some providers disable this action — not fatal

    const insCat = d.prepare(
      "INSERT OR REPLACE INTO categories (id, name, source) VALUES (?, ?, ?)",
    );
    d.transaction(() => {
      d.prepare("DELETE FROM categories WHERE source = ?").run(src);
      for (const c of cats) {
        if (c?.category_id && c?.category_name) insCat.run(String(c.category_id), String(c.category_name), src);
      }
    })();

    // 2) channels ------------------------------------------------------------
    let streams = [];
    try {
      streams = await apiJson(xtreamApi(provider, "get_live_streams"));
      if (!Array.isArray(streams)) streams = [];
    } catch { streams = []; }

    const insCh = d.prepare(
      `INSERT OR REPLACE INTO channels (numericId, name, logo, categoryId, url, tvgId, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    d.transaction(() => {
      d.prepare("DELETE FROM channels WHERE source = ?").run(src);
      if (streams.length) {
        const u = encodeURIComponent(provider.username);
        const p = encodeURIComponent(provider.password);
        for (const s of streams) {
          const id = String(s.stream_id ?? s.id ?? "").trim();
          if (!id) continue;
          insCh.run(
            id,
            s.name || "Unknown channel",
            s.stream_icon || s.stream_icon_plain || "",
            String(s.category_id ?? ""),
            `${provider.host}/live/${u}/${p}/${id}.m3u8`,
            String(s.epg_channel_id ?? ""),
            src,
          );
          added++;
        }
      }
    })();

    // Fallback: provider blocked get_live_streams → rebuild from saved playlist
    if (!streams.length) {
      const data = await readIptv();
      const srcKey = `xtream:${provider.host}/${encodeURIComponent(provider.username)}`;
      const chs = (data.channels || []).filter((c) => c.source === srcKey);
      const u = encodeURIComponent(provider.username);
      const p = encodeURIComponent(provider.password);
      void u; void p; // ids are parsed from the playlist URLs themselves
      d.transaction(() => {
        for (const c of chs) {
          const id = numericIdFromUrl(c.url);
          if (!id) continue;
          insCh.run(id, c.name || "Unknown", c.logo || "", "", c.url, c.tvgId || "", src);
          added++;
        }
      })();
    }

    // 3) EPG -----------------------------------------------------------------
    if (skipEpg) {
      updates.push("EPG skipped (requested)");
    } else {
    try {
      const known = new Set(
        d.prepare("SELECT tvgId FROM channels WHERE source = ?").all(src).map((r) => r.tvgId.toLowerCase()),
      );
      const epgUrl = `${provider.host}/xmltv.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}`;
      const xml = await fetchXmltv(epgUrl);
      const progs = parseXmltvProgrammes(xml, known); // filter happens DURING parse (Pi-RAM safe)
      const insProg = d.prepare(
        "INSERT OR REPLACE INTO programmes (tvgId, title, start, stop) VALUES (?, ?, ?, ?)",
      );
      d.transaction(() => {
        d.prepare(
          "DELETE FROM programmes WHERE tvgId IN (SELECT tvgId FROM channels WHERE source = ?)",
        ).run(src);
        for (const t of progs) {
          insProg.run(t.tvgId, t.title, t.start, t.stop);
        }
      })();
      epgRows = d.prepare("SELECT COUNT(*) n FROM programmes").get().n;
    } catch (e) {
        updates.push(`EPG skipped (${e.message})`);
        // Not fatal — channels/categories above are already cached fine.
      }
    }

    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`lastSync:${src}`, new Date().toISOString());

    stats.push({ source: src, categories: cats.length, channels: added, epgRows, notes: updates });
  }

  return stats;
}

/* -------------------------------- queries -------------------------------- */

export function listCategories() {
  return getDb()
    .prepare("SELECT id, name, source FROM categories ORDER BY name")
    .all();
}

export function listChannels(categoryId = null, limit = 20000) {
  const d = getDb();
  if (categoryId) {
    return d.prepare(
      "SELECT numericId, name, logo, categoryId, tvgId FROM channels WHERE categoryId = ? ORDER BY name LIMIT ?",
    ).all(String(categoryId), limit);
  }
  return d.prepare(
    "SELECT numericId, name, logo, categoryId, tvgId FROM channels ORDER BY name LIMIT ?",
  ).all(limit);
}

export function getChannel(numericId) {
  return getDb()
    .prepare("SELECT * FROM channels WHERE numericId = ?")
    .get(String(numericId || "").replace(/\.m3u8$|\.ts$/i, ""));
}

export function programmesFor(tvgId, fromMs, toMs) {
  return getDb()
    .prepare("SELECT title, start, stop FROM programmes WHERE tvgId = ? AND stop > ? AND start < ? ORDER BY start")
    .all(tvgId, fromMs, toMs);
}

export function dbStatus() {
  const d = getDb();
  const one = (sql) => d.prepare(sql).get()?.n ?? 0;
  const lastSyncs = d.prepare("SELECT key, value FROM meta WHERE key LIKE 'lastSync:%'").all();
  return {
    categories: one("SELECT COUNT(*) n FROM categories"),
    channels: one("SELECT COUNT(*) n FROM channels"),
    programmes: one("SELECT COUNT(*) n FROM programmes"),
    lastSync: lastSyncs,
  };
}
