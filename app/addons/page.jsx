"use client";

import Link from "next/link";
import Hls from "hls.js";
import PipButton from "../components/PipButton";
import ContinueRow from "../components/ContinueRow";
import { useWatchProgress } from "../components/watchProgress";
import { useEffect, useMemo, useRef, useState } from "react";

const DEMO_NOTE = "Tip: e.g. https://v3-cinemeta.strem.io/manifest.json (official movie/show catalogs)";

function Player({ url, title, poster, back }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("Connecting…");
  useWatchProgress(videoRef, url, { title, poster, type: "movie" });
  const proxy = (u) => `/api/tv/play?u=${encodeURIComponent(u)}`;

  useEffect(() => {
    // Same-origin URLs (server torrent engine) play directly; remote URLs
    // go through the usual proxy + transcode fallback chain.
    const isLocal = url.startsWith("/");
    const safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent || "");
    // Torrents are often HEVC or in .mkv containers — Chrome usually copes
    // directly, but iPhone Safari stalls silently on those. On Safari we
    // therefore convert first; elsewhere we try the direct stream, then convert.
    const localCands = [
      { url: `/api/tv/transcode?u=${encodeURIComponent(url)}&f=hls`, hls: true, label: "⚙️ Converting on the server (browser-safe) — starting…" },
      { url, hls: /\.m3u8/i.test(url) },
    ];
    const cands = isLocal
      ? (safari ? localCands : [...localCands.reverse()])
      : /\.m3u8/i.test(url)
        ? [{ url: proxy(url), hls: true }, { url: `/api/tv/transcode?u=${encodeURIComponent(url)}&f=hls`, hls: true }]
        : [{ url: proxy(url) }, { url: `/api/tv/transcode?u=${encodeURIComponent(url)}&f=hls`, hls: true }];
    const processing = isLocal ? "⚙️ Torrent engine: downloading on the server (first play can take a minute)…" : "Connecting…";
    let i = 0, settled = false, hls = null, watchdog = null;
    const el = videoRef.current;

    function cleanup() {
      if (hls) { hls.destroy(); hls = null; }
      clearTimeout(watchdog);
      el.onerror = null; el.onplaying = null;
      el.removeAttribute("src");
    }
    function advance() { cleanup(); i += 1; tryCand(); }
    function tryCand() {
      if (i >= cands.length) { setStatus("This source failed to play."); return; }
      const c = cands[i];
      setStatus(processing);
      watchdog = setTimeout(() => { if (!settled && el.readyState < 3) advance(); }, isLocal ? 120000 : 15000);
      // On iPhone/iPad, prefer Safari's NATIVE HLS (el.src) over hls.js:
      // recent iOS can run hls.js too, but MSE media is not AirPlay-castable
      // and hides the AirPlay icon. Native HLS is the only path that gives
      // the AirPlay button on Apple devices.
      const nativeHls = el.canPlayType("application/vnd.apple.mpegurl");
      if (c.hls && nativeHls) {
        el.onplaying = () => { settled = true; clearTimeout(watchdog); setStatus(""); };
        el.onerror = () => { if (!settled) advance(); };
        el.src = c.url;
        el.play().catch(() => {});
      } else if (c.hls && Hls.isSupported()) {
        hls = new Hls({ manifestLoadingTimeOut: 12000 });
        hls.on(Hls.Events.MANIFEST_PARSED, () => { settled = true; clearTimeout(watchdog); setStatus(""); el.play().catch(() => {}); });
        hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) advance(); });
        hls.loadSource(c.url);
        hls.attachMedia(el);
      } else {
        el.onplaying = () => { settled = true; clearTimeout(watchdog); setStatus(""); };
        el.onerror = () => { if (!settled) advance(); };
        el.src = c.url;
        el.play().catch(() => {});
      }
    }
    tryCand();
    return cleanup;
  }, [url]);

  return (
    <div className="playerBox" style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <video x-webkit-airplay="allow" disableRemotePlayback="false" ref={videoRef} controls autoPlay playsInline />
      <PipButton videoRef={videoRef} style={{ position: "absolute", top: 10, right: 10, zIndex: 5 }} />
      <div style={{ padding: "8px 2px 0" }}>
        {status && <div className="notice" style={{ color: "var(--muted)" }}>{status}</div>}
        <h2 className="wtitle">{title}</h2>
        <button className="btn ghost" onClick={back}>← Back</button>
      </div>
    </div>
  );
}

export default function AddonsPage() {
  const [addons, setAddons] = useState(null);
  const [manifestUrl, setManifestUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [cat, setCat] = useState(null);      // { addon, type, id, name }
  const [metas, setMetas] = useState(null);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null); // meta
  const [streams, setStreams] = useState(null);
  const [playing, setPlaying] = useState(null); // { url, title }
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null); // null = off, [] = none
  const [searching, setSearching] = useState(false);
  const [cwKey, setCwKey] = useState(0);
  const detailRef = useRef(null);
  const searchTimer = useRef(null);

  async function loadAddons() {
    const res = await fetch("/api/addons");
    setAddons((await res.json()).addons);
  }
  useEffect(() => { loadAddons(); }, []);

  // Debounced addon search — searches every installed addon at once
  useEffect(() => {
    clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/addons/search?q=${encodeURIComponent(q)}&type=movie`);
        const out = await res.json();
        setSearchResults(res.ok ? out.metas : []);
      } catch {
        setSearchResults([]);
      }
      setSearching(false);
    }, 450);
    return () => clearTimeout(searchTimer.current);
  }, [query]);

  async function install(e) {
    e.preventDefault();
    if (!manifestUrl.trim()) return;
    setBusy(true); setMsg({ kind: "info", text: "Fetching addon manifest…" });
    const res = await fetch("/api/addons", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifestUrl: manifestUrl.trim() }),
    });
    const out = await res.json();
    setBusy(false);
    if (!res.ok) { setMsg({ kind: "err", text: out.error }); return; }
    setMsg({ kind: "ok", text: `Installed “${out.addon.name}” — ${out.catalogs.length} catalog(s)` });
    setManifestUrl("");
    loadAddons();
  }

  async function uninstall(id) {
    await fetch("/api/addons", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setCat(null); setMetas(null);
    setDetail(null); setStreams(null); setPlaying(null);
    loadAddons();
  }

  async function openCatalog(a, c) {
    setPlaying(null); setDetail(null); setStreams(null);
    setCat({ addon: a, type: c.type, id: c.id, name: c.name || c.id, typeLabel: c.type });
    setMetas(null); setPage(1);
    await fetchPage(a, c, 1);
  }

  async function fetchPage(a, c, pageNo) {
    setMetas(null);
    const url = `/api/addons/catalog?a=${encodeURIComponent(a.id)}&type=${c.type}&cat=${encodeURIComponent(c.id)}&page=${pageNo}`;
    const res = await fetch(url);
    const out = await res.json();
    setMetas(res.ok ? out.metas : []);
    if (!res.ok) setMsg({ kind: "err", text: out.error });
  }

  async function openDetail(m) {
    setDetail(m); setStreams(null);
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    const usable = addons.filter((a) => a.types.includes(m.type) || a.types.includes("all"));
    const players = [];
    for (const a of usable) {
      const res = await fetch(`/api/addons/stream?a=${encodeURIComponent(a.id)}&type=${m.type}&id=${encodeURIComponent(m.id)}`);
      const out = await res.json();
      if (res.ok) for (const s of out.streams) players.push({ ...s, addon: a.name });
    }
    setStreams(players);
  }

  if (!addons) return <div className="main" style={{ padding: 40, color: "var(--muted)" }}>Loading…</div>;

  const allCatalogs = addons.flatMap((a) => a.catalogs.map((c) => ({ addon: a, type: c.type || a.types[0] || "movie", id: c.id || "top", name: c.name || c.id || "Catalog" })));

  return (
    <div className={`shell${menuOpen ? " nav-open" : ""}`}>
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
        {addons.length > 0 && (
          <div className="panel" style={{ marginTop: 16, padding: 12 }}>
            <h3 style={{ fontSize: 13 }}>Installed</h3>
            {addons.map((a) => (
              <div key={a.id} style={{ margin: "8px 0" }}>
                <div className="tag" style={{ display: "block" }}>
                  {a.logo ? <img src={a.logo} alt="" style={{ height: 14, marginRight: 4, verticalAlign: "-2px" }} onError={(e) => (e.currentTarget.style.display = "none")} /> : "🧩 "}
                  {a.name}
                </div>
                <button className="btn ghost" style={{ marginTop: 4, fontSize: 11, padding: "4px 8px", width: "100%" }} onClick={() => uninstall(a.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      <main className="main">
        <div className="head">
          <button className="menuBtn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>☰</button>
          <h1>Addons</h1>
          <input className="search" placeholder="🔍 Search movies across addons…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {playing && <Player url={playing.url} title={playing.title} poster={playing.poster || ""} back={() => { setPlaying(null); setCwKey((k) => k + 1); }} />}

        {!playing && (
          <ContinueRow
            refreshKey={cwKey}
            onSelect={(x) => setPlaying({ url: x.id, title: x.title, poster: x.poster })}
          />
        )}

        {query.trim() ? (
          <section>
            <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)" }}>
              {searching ? "Searching addons…" : `Search results for “${query.trim()}”`}
            </h2>
            {!searching && searchResults?.length === 0 && (
              <div className="empty">Nothing found across your installed addons.</div>
            )}
            <div className="chGrid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
              {(searchResults || []).map((m) => (
                <button key={`${m.id}-${m.name}`} className="card" onClick={() => openDetail(m)} style={{ textAlign: "left" }}>
                  {m.poster
                    ? <img src={m.poster} alt="" loading="lazy" style={{ width: "100%", borderRadius: 8 }} onError={(e) => (e.currentTarget.style.opacity = 0.25)} />
                    : <div style={{ fontSize: 40, textAlign: "center" }}>🎬</div>}
                  <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                  {m.year && <div style={{ color: "var(--muted)", fontSize: 12 }}>{m.year}{m.rating ? ` · ⭐ ${m.rating}` : ""}</div>}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            <section className="panel">
              <h3>Install an addon</h3>
              <p>Paste any Stremio-compatible addon's <b>manifest.json</b> URL. Its catalogs appear here and its stream sources appear when you open a title.</p>
              <form className="row" onSubmit={install}>
                <input className="input" placeholder={DEMO_NOTE} value={manifestUrl} onChange={(e) => setManifestUrl(e.target.value)} spellCheck={false} autoComplete="off" />
                <button className="btn" type="submit" disabled={busy || !manifestUrl.trim()}>{busy ? "Installing…" : "Install"}</button>
              </form>
              {msg && (
                <div className="notice" style={msg.kind === "err" ? { color: "#ff8f8f", borderColor: "#46242a" } : undefined}>
                  {msg.text}
                </div>
              )}
            </section>

            <section className="hrow" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {allCatalogs.map((c, i) => (
                <button
                  key={i}
                  className="btn"
                  style={{ background: cat && cat.addon.id === c.addon.id && cat.id === c.id ? "var(--accent, #3b82f6)" : undefined, color: cat && cat.addon.id === c.addon.id && cat.id === c.id ? "#fff" : undefined }}
                  onClick={() => openCatalog(c.addon, c)}
                >
                  {c.addon.name} · {c.name}
                </button>
              ))}
            </section>

            {cat && (
              <>
                <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)" }}>{cat.addon.name} — {cat.name}</h2>
                {!metas ? (
                  <div className="empty">Loading catalog…</div>
                ) : metas.length === 0 ? (
                  <div className="empty">Nothing in this catalog.</div>
                ) : (
                  <div className="chGrid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
                    {metas.map((m) => (
                      <button key={`${m.id}-${m.name}`} className="card" onClick={() => openDetail(m)} style={{ textAlign: "left" }}>
                        {m.poster
                          ? <img src={m.poster} alt="" loading="lazy" style={{ width: "100%", borderRadius: 8 }} onError={(e) => (e.currentTarget.style.opacity = 0.25)} />
                          : <div style={{ fontSize: 40, textAlign: "center" }}>🎬</div>}
                        <div style={{ fontWeight: 600, fontSize: 13, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                        {m.year && <div style={{ color: "var(--muted)", fontSize: 12 }}>{m.year}{m.rating ? ` · ⭐ ${m.rating}` : ""}</div>}
                      </button>
                    ))}
                  </div>
                )}
                <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => { const n = page + 1; setPage(n); fetchPage(cat.addon, cat, n); }}>
                  Load more
                </button>
              </>
            )}
          </>
        )}

        {detail && (
          <section className="panel" style={{ marginTop: 16 }} onClick={(e) => e.stopPropagation()} ref={detailRef}>
            <div style={{ display: "flex", gap: 16 }}>
              {detail.poster && <img src={detail.poster} alt="" style={{ width: 140, borderRadius: 10 }} />}
              <div style={{ minWidth: 0 }}>
                <h3 style={{ margin: "0 0 4px" }}>{detail.name}</h3>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>{detail.year}{detail.rating ? ` · ⭐ ${detail.rating}` : ""}</div>
                {detail.description && <p style={{ fontSize: 14, lineHeight: 1.5 }}>{detail.description}</p>}
              </div>
            </div>
            <div style={{ marginTop: 10, fontWeight: 700 }}>
              {streams ? (streams.length ? `🎞️ ${streams.length} source(s) found — click one to play` : "No addon sources for this title — try another movie") : "🔎 Checking installed addons for sources… (a few seconds)"}
            </div>
            {streams && streams.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {streams.map((s, i) => (
                  <button
                    key={i}
                    className="btn"
                    style={{ display: "block", width: "100%", marginTop: 6, textAlign: "left", padding: "8px 12px", opacity: s.playable ? 1 : 0.5 }}
                    disabled={!s.playable}
                    onClick={() => s.playable && setPlaying({ url: s.url, title: `${detail.name}${s.quality ? ` — ${s.quality}` : ""} (${s.addon})`, poster: detail.poster || "" })}
                  >
                    {s.playable ? (s.source === "torrent" ? "🌐" : "▶") : "🚫"} {s.addon}{s.addon && " — "}{s.title}{s.quality ? ` · ${s.quality}` : ""}{s.size ? ` · ${s.size}` : ""}
                    {s.source === "torrent" && <span style={{ color: "var(--muted)", fontSize: 12 }}> (streamed by server torrent engine)</span>}
                    {!s.playable && <span style={{ color: "var(--muted)", fontSize: 12 }}> (unplayable source)</span>}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
