"use client";

import Link from "next/link";
import Hls from "hls.js";
import PipButton from "../components/PipButton";
import ContinueRow from "../components/ContinueRow";
import { useWatchProgress } from "../components/watchProgress";
import { useEffect, useMemo, useRef, useState } from "react";

/** Playback chain for VOD files — movies/episodes are usually mp4/mkv. */
const IS_IOS = typeof navigator !== "undefined" && /iPhone|iPod|iPad/.test(navigator.userAgent);

function buildVodCandidates(url) {
  const cands = [];
  const proxy = `/api/tv/play?u=${encodeURIComponent(url)}`;
  const transcode = `/api/tv/transcode?u=${encodeURIComponent(url)}`;
  const restream = `/api/tv/transcode?u=${encodeURIComponent(url)}&f=hls`;

  // iOS can only ever play an HLS stream (or a plain mp4). For mkv/avi the raw
  // hop is a guaranteed failure that just delays the real candidate — skip it
  // and lead with the converter, which iPhone must always use anyway.
  const mkvish = /\.(mkv|avi|wmv|flv|mpeg|mpg)$/i.test(url);
  if (IS_IOS && mkvish) {
    cands.push({ url: restream, engine: "restream", label: "Converting…" });
    cands.push({ url: transcode, engine: "native", label: "Converting…" });
  } else if (mkvish) {
    // Try the player first (Chrome copes with many mkv/avi), then convert.
    cands.push({ url: proxy, engine: "native", label: "" });
    cands.push({ url: transcode, engine: "native", label: "Converting…" });
    cands.push({ url: restream, engine: "restream", label: "Converting…" });
    cands.push({ url: transcode, engine: "native", label: "Converting…" });
  } else {
    cands.push({ url: proxy, engine: "native", label: "" });
    cands.push({ url: restream, engine: "restream", label: "Converting…" });
    cands.push({ url: transcode, engine: "native", label: "Converting…" });
  }
  return cands;
}

function Player({ url, title, poster, back }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("Connecting…");
  useWatchProgress(videoRef, url, { title, poster, type: "movie" });

  useEffect(() => {
    const candidates = buildVodCandidates(url);
    let candidateIdx = 0;
    let settled = false;
    const el = videoRef.current;
    let watchdog = null;
    let hls = null;

    function advance() {
      cleanupAttempt();
      candidateIdx += 1;
      tryCandidate();
    }

    function cleanupAttempt() {
      if (hls) { hls.destroy(); hls = null; }
      el.onplaying = null;
      el.onerror = null;
      el.removeAttribute("src");
    }

    function tryCandidate() {
      if (candidateIdx >= candidates.length) {
        setStatus("This title failed to play in every format.");
        return;
      }
      const cand = candidates[candidateIdx];
      setStatus(cand.label || "");
      // Conversions on the Pi take a while before the first playable piece
      // (loading + probing a multi-GB mkv). 15 s killed iPhones (which always
      // convert) while PCs (direct native) never noticed. Give converts 60 s.
      watchdog = setTimeout(() => {
        if (settled || el.readyState >= 3) return;
        advance();
      }, /transcode/.test(cand.url) ? 60000 : 15000);

      if ((cand.engine === "hls" || cand.engine === "restream") && Hls.isSupported()) {
        hls = new Hls({ manifestLoadingTimeOut: 12000, fragLoadingTimeOut: 20000 });
        hls.on(Hls.Events.MANIFEST_PARSED, () => { try { el.play(); } catch {} });
        hls.on(Hls.Events.ERROR, (_evt, d) => { if (d.fatal) advance(); });
        hls.loadSource(cand.url);
        hls.attachMedia(el);
      } else {
        el.onplaying = () => { settled = true; clearTimeout(watchdog); if (!cand.label) setStatus(""); };
        el.onerror = () => { if (!settled) advance(); };
        el.src = cand.url;
        el.play().catch(() => {});
      }
    }

    tryCandidate();
    return () => {
      settled = true;
      clearTimeout(watchdog);
      cleanupAttempt();
    };
  }, [url]);

  return (
    <div className="playerBox" style={{ position: "relative" }}>
      <video x-webkit-airplay="allow" disableRemotePlayback="false" ref={videoRef} controls autoPlay playsInline />
      <div style={{ position: "absolute", top: 10, right: 10, zIndex: 5 }}>
        <PipButton videoRef={videoRef} />
      </div>
      {status && <div className="notice" style={{ marginTop: 8, color: "var(--muted)" }}>{status}</div>}
      <button className="btn ghost" style={{ marginTop: 8 }} onClick={back}>← Back to browse</button>
      <h2 className="wtitle">{title}</h2>
    </div>
  );
}

function PosterCard({ item, onClick }) {
  return (
    <button className="card vodCard" onClick={onClick} title={item.title}>
      {item.poster
        ? <img src={item.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.opacity = 0.25)} />
        : <div className="noPoster">🎬</div>}
      <div className="vodName">{item.title}</div>
      {(item.year || item.rating) && (
        <div className="vodMeta">
          {item.year && <span>{item.year}</span>}
          {item.rating && <span>⭐ {Number(item.rating).toFixed?.(1) || item.rating}</span>}
        </div>
      )}
    </button>
  );
}

export default function VodPage() {
  const [data, setData] = useState(null);          // movies+series cache
  const [tab, setTab] = useState("movies");         // movies | series
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [detail, setDetail] = useState(null);       // opened series
  const [detailEpisodes, setDetailEpisodes] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [playing, setPlaying] = useState(null);     // { url, title }
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cwKey, setCwKey] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/vod");
        const json = await res.json();
        setData(json);
        if (json.movies.length + json.series.length === 0 && !json.error) {
          const r2 = await fetch("/api/vod?refresh=1");
          setData(await r2.json());
        }
      } catch {
        setData({ error: "Couldn't load the movies list", movies: [], series: [] });
      }
    })();
  }, []);

  const list = useMemo(() => {
    const raw = tab === "movies" ? data?.movies || [] : data?.series || [];
    const q = query.trim().toLowerCase();
    return raw
      .filter((x) => category === "All" || x.category === category)
      .filter((x) => !q || x.title.toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }, [data, tab, query, category]);

  const categories = useMemo(() => {
    const raw = tab === "movies" ? data?.movies || [] : data?.series || [];
    return ["All", ...[...new Set(raw.map((x) => x.category).filter(Boolean))].sort()];
  }, [data, tab]);

  async function openSeries(item) {
    setDetail(item);
    setDetailEpisodes(null);
    setLoadingDetail(true);
    setPlaying(null);
    setMenuOpen(false);
    try {
      const res = await fetch(`/api/vod/series?prov=${encodeURIComponent(item.prov)}&id=${encodeURIComponent(item.id)}`);
      const json = await res.json();
      if (json.error) setDetailEpisodes({ error: json.error });
      else setDetailEpisodes(json);
    } catch {
      setDetailEpisodes({ error: "Couldn't load this series" });
    }
    setLoadingDetail(false);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/vod?refresh=1");
      setData(await res.json());
    } catch {}
    setRefreshing(false);
  }

  async function play(item, labelOverride) {
    let url = item.url || item.urlFromApi;
    // Older cached catalogs have no url field — resolve it live against the
    // provider so a movie click always has something to play.
    if (!url && item.prov && item.id) {
      try {
        const res = await fetch(`/api/vod/movie-url?prov=${encodeURIComponent(item.prov)}&id=${encodeURIComponent(item.id)}&container=${encodeURIComponent(item.container || "mp4")}`);
        url = (await res.json()).url || url;
      } catch {}
    }
    if (!url) return;
    setPlaying({ url, title: labelOverride ? `${item.title} · ${labelOverride}` : item.title, poster: item.poster || "" });
    setMenuOpen(false);
  }

  const total = (data?.movies?.length || 0) + (data?.series?.length || 0);

  return (
    <div className={`shell${menuOpen ? " nav-open" : ""}`}>
      {menuOpen && <div className="navOverlay" onClick={() => setMenuOpen(false)} />}
      <aside className="side">
        <div className="brand">Home<span>Stream</span></div>
        <nav>
          <Link href="/">🎬 Library</Link>
          <Link href="/tv">📺 Live TV</Link>
          <Link href="/vod" className="router-link-active">🍿 Movies & TV</Link>
          <Link href="/addons">🧩 Addons</Link>
        </nav>
        {data && (
          <div className="notice" style={{ marginTop: 16 }}>
            {data.movies?.length || 0} movies · {data.series?.length || 0} series
            {data.refreshed && (
              <div style={{ opacity: 0.7, marginTop: 4, fontSize: 11 }}>from provider, refreshing is free</div>
            )}
          </div>
        )}
        <button className="btn" style={{ marginTop: 12, width: "100%" }} disabled={refreshing} onClick={refresh}>
          {refreshing ? "Refreshing…" : "🔄 Refresh from provider"}
        </button>
      </aside>

      <main className="main">
        <div className="head">
          <button className="menuBtn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>☰</button>
          <h1>Movies & TV Shows</h1>
          <input
            className="search"
            placeholder={`Search ${total} titles…`}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPlaying(null); }}
          />
          {categories.length > 2 && (
            <select className="input" style={{ width: 200 }} value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>

        {!data && <div className="panel" style={{ padding: 24, color: "var(--muted)" }}>Loading your provider&apos;s catalog…</div>}

        {detail ? (
          <section className="panel">
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              {detail.poster && <img src={detail.poster} alt="" style={{ width: 140, borderRadius: 8 }} onError={(e) => (e.currentTarget.style.display = "none")} />}
              <div style={{ flex: 1, minWidth: 240 }}>
                <button className="btn ghost" onClick={() => { setDetail(null); setDetailEpisodes(null); setPlaying(null); }}>← All titles</button>
                <h2 style={{ margin: "10px 0 4px" }}>{detail.title}</h2>
                {detail.genre && <div className="tag">{detail.genre}</div>}
                {detailEpisodes?.overview && <p style={{ color: "var(--muted)", maxWidth: 640 }}>{detailEpisodes.overview}</p>}
              </div>
            </div>

            {loadingDetail && <p style={{ color: "var(--muted)" }}>Loading episodes…</p>}
            {detailEpisodes?.error && <div className="notice" style={{ color: "#ff8f8f", borderColor: "#46242a" }}>{detailEpisodes.error}</div>}
            {detailEpisodes?.seasons?.map((s) => (
              <div key={s.season} style={{ marginTop: 18 }}>
                <h3>Season {s.season}</h3>
                <div className="epList">
                  {s.episodes.map((e) => (
                    <button
                      key={e.episodeNum}
                      className="ep"
                      onClick={() => play({ url: e.url, title: detail.title }, `S${s.season}E${e.episodeNum} — ${e.title}`)}
                    >
                      ▶ {e.episodeNum}. {e.title}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <button className={`btn${tab === "movies" ? "" : " ghost"}`} onClick={() => { setTab("movies"); setCategory("All"); }}>
                🎬 Movies ({data?.movies?.length || 0})
              </button>
              <button className={`btn${tab === "series" ? "" : " ghost"}`} onClick={() => { setTab("series"); setCategory("All"); }}>
                📺 Series ({data?.series?.length || 0})
              </button>
            </div>

            {data?.movies?.length + data?.series?.length === 0 && !refreshing && (
              <div className="panel" style={{ padding: 20 }}>
                <p>No movies or series were returned by your provider yet. Hit the refresh button — the first pull happens right after connecting.</p>
              </div>
            )}

            {playing && <Player url={playing.url} title={playing.title} poster={playing.poster || ""} back={() => { setPlaying(null); setCwKey((k) => k + 1); }} />}
            {!playing && (
              <ContinueRow
                refreshKey={cwKey}
                onSelect={(x) => setPlaying({ url: x.id, title: x.title, poster: x.poster })}
              />
            )}

            <div className="grid vodGrid">
              {list.map((item, i) => (
                <PosterCard
                  key={`${item.prov}:${item.id}:${i}`}
                  item={item}
                  onClick={() => (tab === "series" ? openSeries(item) : play(item))}
                />
              ))}
            </div>
            {list.length === 0 && data && <p style={{ color: "var(--muted)" }}>Nothing matches that search.</p>}
          </>
        )}
      </main>
    </div>
  );
}
