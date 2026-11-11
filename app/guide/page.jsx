"use client";

import Link from "next/link";
import Hls from "hls.js";
import PipButton from "../components/PipButton";
import { useEffect, useMemo, useRef, useState } from "react";

const HLS_RE = /\.(m3u8)/i;
const TS_RE = /\.ts(\?|$)|\.ts$/i;

function fmtClock(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
}

function fmtWindow(p) {
  if (!p?.s) return "";
  return `${fmtClock(p.s)} – ${fmtClock(p.e)}`;
}

/** Same playback fallback chain as Live TV: direct HLS → restream → transcode. */
function buildCandidates(url) {
  const restream = `/api/tv/transcode?u=${encodeURIComponent(url)}&f=hls`;
  const cands = [];
  if (HLS_RE.test(url)) {
    cands.push({ url: `/api/tv/play?u=${encodeURIComponent(url)}`, hls: true });
    cands.push({ url: restream, hls: true });
  } else if (TS_RE.test(url)) {
    cands.push({ url: `/api/tv/play?u=${encodeURIComponent(url.replace(/\.ts(\?|$)/i, ".m3u8$1"))}`, hls: true });
    cands.push({ url: restream, hls: true });
  } else {
    cands.push({ url: `/api/tv/play?u=${encodeURIComponent(url)}`, hls: false });
    cands.push({ url: restream, hls: true });
  }
  return cands;
}

export default function GuidePage() {
  const [data, setData] = useState(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("All Channels");
  const [selected, setSelected] = useState(null); // currently previewed channel
  const [zoomed, setZoomed] = useState(false);    // press screen → window zooms in
  const [epgBusy, setEpgBusy] = useState(false);
  const [epgMsg, setEpgMsg] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const videoRef = useRef(null);

  async function load() {
    const res = await fetch("/api/tv/guide");
    const out = await res.json();
    setData(out);
    setSelected((s) => out.channels.find((c) => c.url === s?.url) || out.channels[0] || null);
  }
  useEffect(() => { load(); }, []);

  const images = data?.total || 0;

  const cats = useMemo(() => {
    if (!data) return ["All Channels"];
    const set = new Set();
    data.channels.forEach((c) => c.group && set.add(c.group));
    return ["All Channels", ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [data]);

  // Matches rows for the Now/Next table
  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.channels.filter(
      (c) =>
        (cat === "All Channels" || c.group === cat) &&
        (!q || c.name.toLowerCase().includes(q) || (c.now?.t || "").toLowerCase().includes(q))
    );
  }, [data, query, cat]);

  // Player for the previewed channel
  useEffect(() => {
    if (!selected || !videoRef.current) return;
    const el = videoRef.current;
    const candidates = buildCandidates(selected.url);
    let idx = 0;
    let hls = null;
    let settled = false;

    function cleanup() {
      if (hls) { hls.destroy(); hls = null; }
      el.onerror = null;
      el.removeAttribute("src");
      el.load?.();
    }
    function tryCand() {
      if (idx >= candidates.length) return;
      const cand = candidates[idx];
      if (cand.hls && Hls.isSupported()) {
        hls = new Hls({ manifestLoadingTimeOut: 12000, fragLoadingTimeOut: 30000, capLevelToPlayerSize: true });
        let recoveries = 0;
        hls.on(Hls.Events.MANIFEST_PARSED, () => { settled = true; el.play().catch(() => {}); });
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          // Live IPTV provider hiccups are routine: recover in-place before
          // giving up. Without this the stream just freezes mid-play.
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 4) {
            recoveries += 1; hls.recoverMediaError(); return;
          }
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR && recoveries < 6) {
            recoveries += 1; hls.startLoad(); return;
          }
          cleanup(); idx += 1; tryCand();
        });
        // Watchdog: if the buffer runs dry while "playing", kick hls.js to
        // resume loading — some upstreams stall the connection silently.
        const kick = setInterval(() => {
          if (!hls || settled !== true) return;
          if (!el.paused && el.readyState < 3 && el.currentTime > 0) {
            try { hls.startLoad(); } catch {}
          }
        }, 5000);
        const origCleanup = cleanup;
        cleanup = () => { clearInterval(kick); origCleanup(); };
        hls.loadSource(cand.url);
        hls.attachMedia(el);
      } else {
        el.onerror = () => { if (settled) return; cleanup(); idx += 1; tryCand(); };
        // Rewind/loop channels end their playlist and stop — loop them
        // seamlessly instead of leaving a paused picture.
        el.onended = () => { try { el.currentTime = 0; el.play().catch(() => {}); } catch {} };
        el.src = cand.url;
        el.play().catch(() => {});
      }
    }
    tryCand();
    return cleanup;
  }, [selected]);

  async function updateGuide(e) {
    e?.preventDefault();
    setEpgBusy(true);
    setEpgMsg({ kind: "info", text: "Downloading the TV guide — big providers can take a minute…" });
    const res = await fetch("/api/tv/epg", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    const out = await res.json();
    setEpgBusy(false);
    if (!res.ok) { setEpgMsg({ kind: "err", text: out.error }); return; }
    setEpgMsg({ kind: "ok", text: `Guide loaded: ${out.programmes} programmes for ${out.channels} channels.` });
    load();
  }

  // any press on the screen (preview or a programme cell) zooms the window in
  function pressScreen(ch) {
    if (ch && ch.url !== selected?.url) setSelected(ch);
    setZoomed(true);
    setMenuOpen(false);
  }

  if (!data) return <div className="main" style={{ padding: 40, color: "var(--muted)" }}>Loading guide…</div>;

  const hasGuide = Boolean(data.fetchedAt);

  return (
    <div className={`shell${menuOpen ? " nav-open" : ""}`}>
      <style>{`
        @keyframes guideZoom { from { transform: scale(.55); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .gPrev.zoomed { position: fixed; inset: 0; margin: auto; z-index: 60; width: min(960px, calc(100vw - 24px)); height: fit-content; align-self: center; animation: guideZoom .28s ease-out; box-shadow: 0 30px 80px rgba(0,0,0,.65); }
        .gBackdrop { position: fixed; inset: 0; background: rgba(8,10,14,.9); z-index: 55; }
        .guideRow:hover { background: rgba(120,170,255,.08); cursor: pointer; }
        .guideRow.sel { background: rgba(94,158,255,.14); }
        .gTable { display: grid; grid-template-columns: minmax(120px, 1.1fr) 1.6fr 1.3fr; }
      `}</style>

      {menuOpen && <div className="navOverlay" onClick={() => setMenuOpen(false)} />}
      <aside className="side">
        <div className="brand">Home<span>Stream</span></div>
        <nav>
          <Link href="/">🎬 Library</Link>
          <Link href="/tv">📺 Live TV</Link>
          <Link href="/guide">🗓️ Guide</Link>
          <Link href="/vod">🍿 Movies & TV</Link>
          <Link href="/addons">🧩 Addons</Link>
        </nav>
        <button className="btn" style={{ marginTop: 16, width: "100%" }} disabled={epgBusy} onClick={updateGuide}>
          {epgBusy ? "Loading guide…" : "📅 Update TV guide"}
        </button>
        {epgMsg && (
          <div className="notice" style={{ marginTop: 8, ...(epgMsg.kind === "err" ? { color: "#ff8f8f", borderColor: "#46242a" } : {}) }}>
            {epgMsg.text}
          </div>
        )}
        {data.fetchedAt && (
          <div className="notice" style={{ marginTop: 8 }}>
            Guide updated {new Date(data.fetchedAt).toLocaleTimeString()}
          </div>
        )}
      </aside>

      <main className="main">
        <div className="head">
          <button className="menuBtn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>☰</button>
          <h1>Live TV Guide</h1>
          <input className="search" placeholder="Search channels or programmes…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
          {/* ---- Preview window (press it to zoom in) ---- */}
          <div style={{ display: "grid", gap: 12, position: "sticky", top: 12 }}>
            {(zoomed && selected) && (
              <div className="gBackdrop" style={{ position: "fixed" }} onClick={() => setZoomed(false)} />
            )}
            <div
              className={`panel gPrev${zoomed ? " zoomed" : ""}`}
              onClick={() => selected && pressScreen(null)}
              style={{ padding: 12, cursor: "pointer", textAlign: "center" }}
              title="Press to zoom in"
            >
              <div style={{ position: "relative" }}>
                <div style={{ width: "100%", aspectRatio: "16/9", background: "#000", borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
                  {selected ? <video x-webkit-airplay="allow" ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%" }} /> : null}
                </div>
                {zoomed && (
                  <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 8, zIndex: 5 }}>
                    <PipButton videoRef={videoRef} />
                    <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setZoomed(false); }}>✕ Close</button>
                  </div>
                )}
              </div>
              {selected && (
                <>
                  <div style={{ fontWeight: 700 }}>
                    {selected.logo && <img src={selected.logo} alt="" style={{ height: 18, marginRight: 6, verticalAlign: "-3px" }} onError={(e) => (e.currentTarget.style.display = "none")} />}
                    {selected.name} <span style={{ marginLeft: 4, color: "#ff5a5a", fontSize: 11 }}>● LIVE</span>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
                    {selected.now ? <>{selected.now.t}<br />{fmtWindow(selected.now)}</> : "No programme listed"}
                  </div>
                  {zoomed && selected.now?.i && <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5 }}>{selected.now.i}</div>}
                  {zoomed && selected.next?.length > 0 && (
                    <div style={{ marginTop: 8, color: "var(--muted)", fontSize: 13 }}>
                      <b style={{ color: "var(--muted)" }}>Up next:</b>
                      {selected.next.map((n) => ` ${fmtClock(n.s)} ${n.t}`).join(" · ")}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="panel" style={{ padding: 10 }}>
              {cats.map((c) => (
                <button
                  key={c}
                  className="btn"
                  style={{
                    display: "block", width: "100%", marginTop: 6, textAlign: "left", padding: "8px 10px",
                    background: cat === c ? "var(--accent, #3b82f6)" : undefined, color: cat === c ? "#fff" : undefined,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                  onClick={() => setCat(c)}
                >
                  {c === "All Channels" ? "🏛️ " : "📁 "}{c}
                </button>
              ))}
            </div>
          </div>

          {/* ---- Guide table: Channel | Now | Next ---- */}
          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div className="gTable" style={{ fontWeight: 700, padding: "10px 14px", borderBottom: "1px solid #2a3342", color: "var(--text)", fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>
              <div>Channel</div><div>Now</div><div>Next</div>
            </div>
            {!hasGuide && (
              <div className="empty" style={{ padding: 20 }}>
                No guide loaded yet — press “📅 Update TV guide” in the sidebar to fetch schedules.
              </div>
            )}
            {rows.slice(0, 250).map((c) => (
              <div key={c.url} className={`gTable guideRow${selected?.url === c.url ? " sel" : ""}`} onClick={() => setSelected(c)}>
                <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  {c.logo ? <img src={c.logo} alt="" style={{ height: 22, flexShrink: 0 }} onError={(e) => (e.currentTarget.style.display = "none")} /> : <span>📺</span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                </div>
                <div style={{ padding: "10px 14px", borderLeft: "1px solid #1d2430", background: selected?.url === c.url ? "var(--accent, #3b82f6)" : undefined, color: selected?.url === c.url ? "#fff" : undefined, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer", fontWeight: selected?.url === c.url ? 700 : 500 }} onClick={(e) => { e.stopPropagation(); pressScreen(c); }} title={c.now?.i || c.now?.t || ""}>
                  {c.now ? c.now.t : "—"}
                  {c.now?.g ? <span style={{ opacity: 0.7, fontSize: 11, marginLeft: 6 }}>{c.now.g}</span> : null}
                </div>
                <div style={{ padding: "10px 14px", borderLeft: "1px solid #1d2430", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.next?.length ? `${fmtClock(c.next[0].s)} ${c.next[0].t}` : "—"}
                </div>
              </div>
            ))}
            {rows.length > 250 && (
              <div className="notice" style={{ margin: 12 }}>Showing first 250 of {rows.length} — search or pick a category to narrow down.</div>
            )}
            {hasGuide && rows.length === 0 && <div className="empty" style={{ padding: 20 }}>Nothing matches this filter.</div>}
            {!hasGuide && rows.length === 0 && (
              <div className="empty" style={{ padding: 20 }}>No channels yet — import a playlist on the Live TV page first.</div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
