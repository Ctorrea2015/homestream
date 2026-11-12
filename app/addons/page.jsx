"use client";

import Link from "next/link";
import Hls from "hls.js";
import PipButton from "../components/PipButton";
import ContinueRow from "../components/ContinueRow";
import { useWatchProgress } from "../components/watchProgress";
import { useEffect, useMemo, useRef, useState } from "react";

const DEMO_NOTE = "Tip: e.g. https://v3-cinemeta.strem.io/manifest.json (official movie/show catalogs)";

/** VLC/Infuse hand-off. In an installed standalone PWA, iOS blocks custom
 * scheme links — and navigator.clipboard is unavailable on plain HTTP.
 * So: show the link as selectable text (long-press → Copy) plus an
 * execCommand fallback that still works on http. */
function ExternalButtons({ url }) {
  const [copied, setCopied] = useState(false);
  const [showLink, setShowLink] = useState(false);
  function copyFallback() {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(ok);
      if (ok) setTimeout(() => setCopied(false), 2500);
      else setShowLink(true);
    } catch {
      setShowLink(true);
    }
  }
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <a className="btn ghost" href={`vlc://x-callback-url/stream?url=${encodeURIComponent(url)}`}>▶ Open in VLC</a>
        <a className="btn ghost" href={`infuse://x-callback-url/play?url=${encodeURIComponent(url)}`}>▶ Open in Infuse</a>
        <button className="btn ghost" onClick={copyFallback}>{copied ? "✓ Copied" : "⧉ Copy stream link"}</button>
      </div>
      {showLink && (
        <input
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          style={{ width: "100%", marginTop: 8, fontSize: 12, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border, #333)", background: "transparent", color: "var(--text, inherit)" }}
        />
      )}
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
        VLC → Network → Network Stream → paste this link
      </div>
    </div>
  );
}

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
};

function Player({ url, sources, title, poster, back }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("Connecting…");
  // Movie-player state: total duration (probed once) and the offset the
  // converter is currently starting from. Tapping the timeline past the
  // converted region restarts the session at that point.
  const [duration, setDuration] = useState(null);
  const [seekBase, setSeekBase] = useState(0);
  const [session, setSession] = useState(0);
  const [tick, setTick] = useState(0);
  useWatchProgress(videoRef, url, { title, poster, type: "movie" });
  const proxy = (u) => `/api/tv/play?u=${encodeURIComponent(u)}`;

  // Ephemeral torrents: when playback closes (Back, tab close, app swipe),
  // tell the server to delete the torrent task + files via rqbit/qB. This
  // keeps streamed movies from piling up on the Pi's disk (Stremio-cache
  // behavior). sendBeacon survives page unload where fetch does not.
  useEffect(() => {
    if (!url?.startsWith("/") || !url.includes("/api/torrent/stream")) return;
    const ih = new URL(url, window.location.origin).searchParams.get("infoHash");
    if (!ih) return;
    const cleanup = () => {
      try {
        navigator.sendBeacon(`/api/torrent/cleanup?infoHash=${ih}&engine=both`);
      } catch {}
    };
    window.addEventListener("pagehide", cleanup);
    return () => { window.removeEventListener("pagehide", cleanup); cleanup(); };
  }, [url]);

  const isTorrent = url?.startsWith("/") && /\/api\/torrent\/stream/.test(url);
  useEffect(() => { setDuration(null); setSeekBase(0); }, [url]);
  useEffect(() => {
    if (!isTorrent) return;
    let dead = false;
    fetch(`/api/tv/probe?u=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!dead && d?.duration) setDuration(d.duration); })
      .catch(() => {});
    return () => { dead = true; };
  }, [url, isTorrent]);
  useEffect(() => {
    if (!duration) return;
    const t = setInterval(() => setTick((k) => k + 1), 1000);
    return () => clearInterval(t);
  }, [duration]);

  useEffect(() => {
    // Candidate chain: every playable stream (the picked source FIRST, then
    // the rest of the addon's sources), each tried direct→convert. Torrent
    // swarms differ wildly in health — cycling sources automatically makes
    // TV shows behave like movies instead of dying on one dead swarm.
    const all = [
      ...(sources || []),
      ...(url ? [{ url, label: "" }] : []),
    ];
    const ua = navigator.userAgent || "";
    // iOS: any browser app (Safari, Opera, Chrome, Firefox on iOS) is really
    // Safari/WebKit underneath — order candidates for it, don't UA-sniff.
    const safari = /iPhone|iPod|iPad/.test(ua) || /^((?!chrome|android).)*safari/i.test(ua);
    const cands = [];
    all.forEach((s, k) => {
      const isLocal = s.url.startsWith("/");
      const shared = s.label ? ` ${s.label}` : "";
      if (isLocal) {
        const seekQ = seekBase > 0 ? `&seek=${Math.floor(seekBase)}` : "";
        const convert = { url: `/api/tv/transcode?u=${encodeURIComponent(s.url)}&f=hls&vod=1${seekQ}`, hls: true, label: s.forceConvert ? `⏩ Skipping to ${fmtTime(seekBase)} — engine grabbing that part…` : `⚙️ Converting on the server (browser-safe)${shared} — starting…` };
        const direct = { url: s.url, hls: /\.m3u8/i.test(s.url), label: "" };
        const pair = s.forceConvert ? [convert] : (safari ? [convert, direct] : [direct, convert]);
        for (const c of pair) {
          cands.push({ ...c, src: k + 1, of: all.length, title: s.title || "" });
        }
      } else {
        cands.push({ url: proxy(s.url), hls: /\.m3u8/i.test(s.url), src: k + 1, of: all.length, label: `Connecting${shared}…` });
        cands.push({ url: `/api/tv/transcode?u=${encodeURIComponent(s.url)}&f=hls&vod=1`, hls: true, src: k + 1, of: all.length, label: `⚙️ Converting${shared}…` });
      }
    });

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
      if (i >= cands.length) { setStatus("All sources failed — the torrent swarms are quiet right now. Try again later or another title."); return; }
      const c = cands[i];
      const srcTag = c.of > 1 ? `Source ${c.src}/${c.of} — ` : "";
      let processing = c.url.startsWith("/")
        ? (c.label || "⚙️ Torrent engine: downloading on the server (first play can take a minute)…")
        : (c.label || "Connecting…");
      setStatus(`${srcTag}${processing}`);
      watchdog = setTimeout(() => { if (!settled && el.readyState < 3) advance(); }, c.url.startsWith("/") ? 120000 : 15000);
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
  }, [url, sources, seekBase, session]);

  // Absolute URL of the currently-playing stream for external players
  // (VLC/Infuse on the phone can play mkv/avi natively — no conversion).
  const externalUrl = (typeof window !== "undefined" && url?.startsWith("/"))
    ? `${window.location.origin}${url}`
    : (url || "");

  // Movie timeline: shown once the duration is known. Tapping a point inside
  // the already-converted region seeks natively (instant); beyond it, the
  // converter restarts at that offset ("skip to").
  const pos = seekBase + (videoRef.current?.currentTime || 0);
  const seekableEnd = seekBase + (videoRef.current?.seekable?.length ? videoRef.current.seekable.end(videoRef.current.seekable.length - 1) : 0);
  function onTimelineTap(e) {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const target = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * duration;
    const el = videoRef.current;
    // Native seek only inside what's converted AND ahead of our start offset;
    // iOS WebKit silently refuses backward seeks on live-style playlists, so
    // anything else restarts the converter at that point (fresh session).
    if (el && target > seekBase + 5 && target < seekableEnd - 2) {
      el.currentTime = Math.max(0, target - seekBase);
    } else {
      setSeekBase(Math.floor(target));
      setSession((s) => s + 1); // force a fresh player session even at offset 0
    }
  }
  const pct = duration ? Math.min(100, (pos / duration) * 100) : 0;

  return (
    <div className="playerBox" style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <video x-webkit-airplay="allow" ref={videoRef} controls autoPlay playsInline />
      <PipButton videoRef={videoRef} style={{ position: "absolute", top: 10, right: 10, zIndex: 5 }} />
      {duration ? (
        <div style={{ padding: "6px 2px 0" }} onClick={(e) => e.stopPropagation()}>
          <div onClick={onTimelineTap} style={{ position: "relative", height: 14, cursor: "pointer" }} title="Tap to jump">
            <div style={{ position: "absolute", top: 5, left: 0, right: 0, height: 4, borderRadius: 2, background: "var(--border, #333)" }} />
            <div style={{ position: "absolute", top: 5, left: 0, width: `${pct}%`, height: 4, borderRadius: 2, background: "var(--accent, #7c6cff)" }} />
            <div style={{ position: "absolute", top: 2, left: `calc(${pct}% - 5px)`, width: 10, height: 10, borderRadius: 5, background: "#fff" }} />
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", justifyContent: "space-between", marginTop: 2 }}>
            <span>{fmtTime(pos)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
          <button className="btn ghost" style={{ marginTop: 4, fontSize: 12 }} onClick={() => { setSeekBase(0); setSession((s) => s + 1); setStatus("⏮ Restarting from the beginning…"); }}>⏮ Restart from beginning</button>
        </div>
      ) : null}
      <div style={{ padding: "8px 2px 0" }}>
        {status && <div className="notice" style={{ color: "var(--muted)" }}>{status}</div>}
        <h2 className="wtitle">{title}</h2>
        {externalUrl && (
          <ExternalButtons url={externalUrl} />
        )}
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
  const [episodes, setEpisodes] = useState(null); // series: episode list from Cinemeta
  const [selEp, setSelEp] = useState(null); // series: episode id currently loaded ("tt..:1:2")
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
        const res = await fetch(`/api/addons/search?q=${encodeURIComponent(q)}`); // movies + series together
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
    setDetail(m); setStreams(null); setEpisodes(null); setSelEp(null);
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    // Series need an episode picked: torrent sources are keyed per-episode
    // (tt0108778:1:2), a show id alone returns nothing. Fetch the episode
    // list from Cinemeta, default to S01E01.
    if (m.type === "series") {
      fetchEpisodes(m).catch(() => {});
      await loadStreams(m.type, m.id);
    } else {
      await loadStreams(m.type, m.id);
    }
  }

  function streamTargetType(m) {
    return m.type || "movie";
  }

  async function fetchEpisodes(s) {
    const d = await (await fetch(`/api/addons/meta?a=com.linvo.cinemeta&type=series&id=${encodeURIComponent(s.id)}`)).json();
    const vids = (d?.meta?.videos || []).filter((v) => v.season > 0);
    if (vids.length) {
      setEpisodes(vids);
      const first = vids.find((v) => v.season === 1 && v.episode === 1) || vids[0];
      setSelEp(first.id);
      loadStreams(first.type || "series", first.id);
    }
  }

  function pickEpisode(v) {
    setSelEp(v.id);
    setStreams(null);
    loadStreams(v.type || "series", v.id);
  }

  async function loadStreams(type, id) {
    const usable = addons.filter((a) => a.types.includes(type) || a.types.includes("all"));
    const players = [];
    for (const a of usable) {
      const res = await fetch(`/api/addons/stream?a=${encodeURIComponent(a.id)}&type=${type}&id=${encodeURIComponent(id)}`);
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
          <input className="search" placeholder="🔍 Search movies & shows across addons…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {playing && <Player url={playing.url} sources={playing.sources} title={playing.title} poster={playing.poster || ""} back={() => { setPlaying(null); setCwKey((k) => k + 1); }} />}

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
              {detail.type === "series" && episodes && episodes.length
                ? (streams && streams.length ? `🎞️ ${streams.length} source(s) for ${selEp?.split(":").slice(1).map(Number).map((n) => String(n).padStart(2, "0")).join("×") || "episode"} — click one to play` : "🔎 Checking addons for this episode's sources…")
                : (streams ? (streams.length ? `🎞️ ${streams.length} source(s) found — click one to play` : "No addon sources for this title — try another movie") : "🔎 Checking installed addons for sources… (a few seconds)")}
            </div>
            {detail.type === "series" && episodes && episodes.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Episodes</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto", padding: 2 }}>
                  {episodes.map((v) => {
                    const active = selEp === v.id;
                    return (
                      <button
                        key={v.id}
                        className="btn ghost"
                        style={{
                          fontSize: 12, padding: "4px 8px",
                          borderColor: active ? "var(--accent, #7c6cff)" : undefined,
                          fontWeight: active ? 700 : 400,
                        }}
                        onClick={() => pickEpisode(v)}
                        title={v.name || ""}
                      >
                        S{String(v.season).padStart(2, "0")}E{String(v.episode).padStart(2, "0")}{v.name ? ` · ${v.name}` : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {streams && streams.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {streams.map((s, i) => (
                  <button
                    key={i}
                    className="btn"
                    style={{ display: "block", width: "100%", marginTop: 6, textAlign: "left", padding: "8px 12px", opacity: s.playable ? 1 : 0.5 }}
                    disabled={!s.playable}
                    onClick={() => {
                      const epTag = selEp && selEp.includes(":")
                        ? selEp.split(":").slice(1)
                        : null;
                      const epKey = epTag ? `S${String(epTag[0]).padStart(2, "0")}E${String(epTag[1] || 0).padStart(2, "0")}` : "";
                      const chosen = { url: s.url + (s.source === "torrent" && epKey ? `&ep=${epKey}` : ""), label: "" };
                      // Keep the other playable sources as automatic backups —
                      // if this torrent's swarm is quiet, the next one starts.
                      const backups = (streams || [])
                        .filter((x) => x !== s && x.playable && x.source === "torrent")
                        .slice(0, 8)
                        .map((x) => ({
                          url: epKey && !x.url.includes("ep=") ? `${x.url}&ep=${epKey}` : x.url,
                          label: (x.title || "").replace(/\s+/g, " ").slice(0, 60),
                        }));
                      return s.playable && setPlaying({
                        url: chosen.url,
                        sources: [chosen, ...backups],
                        title: `${detail.name}${epKey ? ` ${epKey}` : ""}${s.quality ? ` — ${s.quality}` : ""} (${s.addon})`,
                        poster: detail.poster || "",
                      });
                    }}
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
