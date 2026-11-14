"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import StreamPlayer from "../components/StreamPlayer";

/**
 * TV App ("10-foot UI") — /tvapp
 * Designed for Samsung/LG TV browsers: huge posters, D-pad navigation.
 *  ◀ ▶ ▲ ▼  move between posters / list items
 *  Enter/OK  → open detail, or play the focused source/episode
 *  Back (Escape/Backspace) → close detail / stop playback
 * Same backend as the rest of HomeStream: provider VOD + addon catalogs +
 * Torrentio sources, movie-style player, ephemeral torrents.
 */

const CSS = `
.tvApp { background:#000; min-height:100vh; color:#fff; font-family:"Segoe UI",system-ui,sans-serif; }
.tvTop { position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:24px;
  padding:14px 4%; background:linear-gradient(180deg, rgba(0,0,0,.9), transparent); }
.tvBrand { color:#e50914; font-weight:900; font-size:26px; letter-spacing:1px; }
.tvHint { color:#888; font-size:13px; }
.tvRow { margin:6px 0 30px; }
.tvRowTitle { font-size:20px; font-weight:800; margin:0 0 10px; padding:0 4%; }
.tvScroll { display:flex; gap:12px; overflow-x:auto; padding:8px 4% 10px; scrollbar-width:none; }
.tvScroll::-webkit-scrollbar { display:none; }
.tvCard { flex:0 0 auto; width:190px; background:none; border:none; color:#fff; text-align:left;
  cursor:pointer; padding:6px; border-radius:8px; transition:transform .15s ease; }
.tvCard img { width:100%; aspect-ratio:2/3; object-fit:cover; border-radius:6px; background:#1c1c1f; display:block; }
.tvCardName { font-size:13px; color:#bbb; margin-top:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tvCard.focus { outline:4px solid #fff; outline-offset:2px; transform:scale(1.08); background:rgba(255,255,255,.06); }
.tvModal { position:fixed; inset:0; z-index:50; background:rgba(0,0,0,.85); overflow-y:auto; }
.tvModalBox { max-width:900px; margin:60px auto; background:#161616; border-radius:12px; padding:34px 40px; }
.tvModalBox h2 { font-size:34px; font-weight:900; margin:0 0 6px; }
.tvModalMeta { color:#aaa; font-size:15px; margin-bottom:12px; }
.tvModalDesc { color:#ddd; font-size:16px; line-height:1.55; max-width:640px; margin-bottom:16px; }
.tvItem { display:block; width:100%; text-align:left; background:#232323; border:2px solid #333;
  color:#fff; padding:13px 16px; border-radius:8px; margin:8px 0; cursor:pointer; font-size:15.5px; }
.tvItem.focus { border-color:#fff; background:#333; }
.tvEp { display:inline-block; background:#232323; border:2px solid #333; color:#fff;
  padding:9px 14px; border-radius:8px; margin:5px 8px 5px 0; cursor:pointer; font-size:14px; }
.tvEp.focus { border-color:#fff; background:#333; }
.tvMuted { color:#999; font-size:15px; }
.tvLoading { color:#999; padding:40px 4%; font-size:16px; }
.tvHero { padding:30px 4% 10px; }
.tvHero h1 { font-size:40px; font-weight:900; margin:0; }
.tvSearchBtn { margin-left:auto; background:#232323; border:2px solid #333; color:#fff;
  padding:8px 20px; border-radius:8px; font-size:15px; cursor:pointer; }
.tvSearchBtn.focus { border-color:#fff; background:#333; }
.tvSearchWrap { max-width:900px; margin:44px auto; padding:0 4%; }
.tvSearchInput { width:100%; box-sizing:border-box; font-size:22px; padding:14px 18px;
  border-radius:10px; border:2px solid #444; background:#161616; color:#fff; outline:none; }
.tvSearchInput:focus { border-color:#e50914; }
.tvResults { margin-top:18px; display:flex; flex-direction:column; gap:8px; }
.tvRes { display:flex; gap:14px; align-items:center; background:#1a1a1a; border:2px solid #333;
  border-radius:10px; padding:10px 14px; color:#fff; cursor:pointer; text-align:left; }
.tvRes.focus { border-color:#fff; background:#2a2a2a; }
.tvRes img { width:46px; height:69px; object-fit:cover; border-radius:4px; background:#1c1c1f; flex:0 0 46px; }
.tvResName { font-size:17px; font-weight:700; }
.tvResMeta { color:#999; font-size:13px; }
`;

const noPoster = (
  <div style={{ width: "100%", aspectRatio: "2/3", borderRadius: 6, background: "#1c1c1f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 40 }}>
    🎬
  </div>
);

const noPosterSm = (
  <div style={{ width: 46, height: 69, borderRadius: 4, background: "#1c1c1f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flex: "0 0 46px" }}>
    🎬
  </div>
);

export default function TvApp() {
  const [addons, setAddons] = useState(null);
  const [vod, setVod] = useState(null);
  const [focus, setFocus] = useState({ r: 0, c: 0 });      // grid focus
  const [listFocus, setListFocus] = useState(0);           // focus inside detail modal
  const [detail, setDetail] = useState(null);              // {kind:'addon'|'prov', meta}
  const [dInfo, setDInfo] = useState(null);
  const [playing, setPlaying] = useState(null);
  const [searchFocus, setSearchFocus] = useState(false);   // header Search button highlighted
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);            // search metas
  const [searching, setSearching] = useState(false);
  const [resultFocus, setResultFocus] = useState(0);
  const cardRefs = useRef({});
  const listRefs = useRef({});
  const listLen = useRef(0);
  const inputRef = useRef(null);
  const resRefs = useRef({});

  useEffect(() => {
    fetch("/api/addons").then((r) => r.json()).then((d) => setAddons(d.addons || [])).catch(() => setAddons([]));
    fetch("/api/vod").then((r) => r.json()).then(setVod).catch(() => setVod({ movies: [], series: [] }));
  }, []);

  const allCatalogs = useMemo(
    () => (addons || []).flatMap((a) => (a.catalogs || []).map((c) => ({ addon: a, type: c.type || a.types?.[0] || "movie", id: c.id || "top", name: c.name || c.id || "Catalog" }))),
    [addons],
  );

  const provMovies = useMemo(
    () => (vod?.movies || []).slice().sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0)).slice(0, 40),
    [vod],
  );
  const provSeries = useMemo(
    () => (vod?.series || []).slice().sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0)).slice(0, 40),
    [vod],
  );

  /** Each row: { title, items, onPick } — the D-pad moves across rows/cards. */
  const rows = useMemo(() => {
    const out = [];
    for (const c of allCatalogs.slice(0, 4)) {
      out.push({ title: `${c.addon.name} · ${c.name}`, kind: "catalog", c, items: null, onPick: (m) => openAddonDetail(m) });
    }
    if (provMovies.length) out.push({ title: "Movies", kind: "prov", items: provMovies, onPick: openProviderDetail });
    if (provSeries.length) out.push({ title: "TV Shows", kind: "prov", items: provSeries, onPick: openProviderDetail });
    return out;
  }, [allCatalogs, provMovies, provSeries]);

  // ---- detail + streams (same logic as the home page) -----------------------
  async function loadStreamsAll(type, id) {
    const usable = (addons || []).filter((a) => (a.types || []).includes(type) || (a.types || []).includes("all"));
    const players = [];
    for (const a of usable) {
      try {
        const res = await fetch(`/api/addons/stream?a=${encodeURIComponent(a.id)}&type=${type}&id=${encodeURIComponent(id)}`);
        const out = await res.json();
        if (res.ok) for (const s of out.streams || []) players.push({ ...s, addon: a.name });
      } catch {}
    }
    return players;
  }

  async function torrentSourcesFor(title, type) {
    try {
      const res = await fetch(`/api/addons/search?q=${encodeURIComponent(title)}`);
      const metas = res.ok ? (await res.json()).metas || [] : [];
      const hit = metas.find((x) => /^tt\d+/.test(String(x.id)) && (!type || x.type === type)) || metas.find((x) => /^tt\d+/.test(String(x.id)));
      return hit ? loadStreamsAll(hit.type || type || "movie", hit.id) : [];
    } catch { return []; }
  }

  function openAddonDetail(m) {
    const type = m.type || "movie";
    setPlaying(null);
    setDetail({ kind: "addon", meta: { ...m, type } });
    setDInfo({ loading: true, streams: null, episodes: null, desc: m.description || "" });
    setListFocus(0);
    (async () => {
      const [streams, meta] = await Promise.all([
        loadStreamsAll(type, m.id),
        (!m.description || type === "series")
          ? fetch(`/api/addons/meta?a=com.linvo.cinemeta&type=${type}&id=${encodeURIComponent(m.id)}`).then((r) => r.json()).catch(() => null)
          : Promise.resolve(null),
      ]);
      const vids = type === "series" ? (meta?.meta?.videos || []).filter((v) => v.season > 0) : null;
      setDInfo({ loading: false, streams, episodes: vids, desc: meta?.meta?.description || m.description || "" });
    })();
  }

  function openProviderDetail(m) {
    setPlaying(null);
    const isSeries = !m.url;
    if (!isSeries) {
      setDetail({ kind: "prov", meta: { ...m, type: "movie", name: m.title } });
      setDInfo({ loading: true, torrent: "pending", desc: "" });
      setListFocus(0);
      torrentSourcesFor(m.title, "movie").then((t) => setDInfo((d) => ({ ...d, loading: false, torrent: t })));
      return;
    }
    setDetail({ kind: "prov", meta: { ...m, type: "series", name: m.title } });
    setDInfo({ loading: true, seasons: null, season: null, torrent: "pending", desc: "" });
    setListFocus(0);
    torrentSourcesFor(m.title, "series").then((t) => setDInfo((d) => ({ ...d, torrent: t })));
    fetch(`/api/vod/series?prov=${encodeURIComponent(m.prov)}&id=${encodeURIComponent(m.id)}`)
      .then((r) => r.json())
      .then((j) => setDInfo((d) => ({ ...d, loading: false, seasons: j.error ? [] : (j.seasons || []), season: (j.seasons || [])[0] || null, desc: j.overview || "", poster: j.poster || m.poster, error: j.error })))
      .catch(() => setDInfo((d) => ({ ...d, loading: false, seasons: [], error: "Couldn't load this series" })));
  }

  function play(url, title, sources = [], poster = "") {
    setPlaying({ url, sources, title, poster });
    setDetail(null);
    setDInfo(null);
  }

  // ---- search (Cinemeta via /api/addons/search) ------------------------------
  function openSearch() {
    setSearchFocus(false);
    setSearchOpen(true);
    setQuery("");
    setResults(null);
    setSearching(false);
    setResultFocus(0);
  }

  async function runSearch() {
    const term = query.trim();
    if (!term) return;
    setSearching(true);
    setResults(null);
    setResultFocus(0);
    try {
      const res = await fetch(`/api/addons/search?q=${encodeURIComponent(term)}`);
      const j = res.ok ? await res.json() : {};
      setResults((j.metas || []).slice(0, 30));
    } catch {
      setResults([]);
    }
    setSearching(false);
  }

  // Auto-search as you type. TV on-screen keyboards (Fire TV/Silk) often don't
  // submit the form on their "Done"/Enter button, so waiting for Enter means
  // results never appear. A short debounce fires the search automatically.
  useEffect(() => {
    if (!searchOpen) return;
    const term = query.trim();
    if (!term) { setResults(null); setSearching(false); return; }
    const t = setTimeout(() => { runSearch(); }, 650);
    return () => clearTimeout(t);
  }, [query, searchOpen]);

  // ---- D-pad handling --------------------------------------------------------
  useEffect(() => {
    function onKey(e) {
      const k = e.key;
      const isBack = k === "Escape" || k === "Backspace" || k === "GoBack" || k === "BrowserBack";
      if (playing) {
        if (isBack) { e.preventDefault(); setPlaying(null); }
        return;
      }
      if (searchOpen) {
        if (isBack) { e.preventDefault(); setSearchOpen(false); setResults(null); setQuery(""); return; }
        const n = (results || []).length;
        if (k === "ArrowDown" && n) {
          // D-pad Down exits the input (and its on-screen keyboard) into the results
          e.preventDefault();
          inputRef.current?.blur();
          setResultFocus(0);
        } else if (k === "ArrowDown" || k === "ArrowUp") {
          if (!n) return;
          e.preventDefault();
          setResultFocus((i) => (k === "ArrowDown" ? Math.min(n - 1, i + 1) : Math.max(0, i - 1)));
        } else if (k === "Enter") {
          if (document.activeElement === inputRef.current) return; // typing — form submits
          e.preventDefault();
          resRefs.current[resultFocus]?.click();
        }
        return;
      }
      if (detail) {
        if (isBack) { e.preventDefault(); setDetail(null); setDInfo(null); return; }
        if (k === "ArrowDown") { e.preventDefault(); setListFocus((i) => Math.min(i + 1, Math.max(0, listLen.current - 1))); }
        else if (k === "ArrowUp") { e.preventDefault(); setListFocus((i) => Math.max(0, i - 1)); }
        else if (k === "Enter") {
          e.preventDefault();
          const el = listRefs.current[listFocus];
          el?.click();
        }
        return;
      }
      if (!rows.length) {
        if (isBack && searchFocus) { e.preventDefault(); setSearchFocus(false); }
        return;
      }
      if (searchFocus) {
        if (k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); setSearchFocus(false); }
        else if (k === "ArrowUp") { e.preventDefault(); }
        else if (k === "Enter") { e.preventDefault(); openSearch(); }
        else if (isBack) { e.preventDefault(); setSearchFocus(false); }
        return;
      }
      if (k === "ArrowRight") { e.preventDefault(); setFocus((f) => ({ ...f, c: Math.min((rows[f.r]?.items?.length || 1) - 1, f.c + 1) })); }
      else if (k === "ArrowLeft") { e.preventDefault(); setFocus((f) => ({ ...f, c: Math.max(0, f.c - 1) })); }
      else if (k === "ArrowDown") { e.preventDefault(); setFocus((f) => ({ r: Math.min(rows.length - 1, f.r + 1), c: 0 })); }
      else if (k === "ArrowUp") {
        e.preventDefault();
        if (focus.r === 0) setSearchFocus(true); // ▲ from the top row reaches the Search button
        else setFocus((f) => ({ r: Math.max(0, f.r - 1), c: 0 }));
      }
      else if (k === "Enter") {
        e.preventDefault();
        const row = rows[focus.r];
        const item = row?.items?.[focus.c];
        if (item) row.onPick(item);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, detail, focus, listFocus, rows, searchOpen, searchFocus, results, resultFocus, query]);

  // Back-button guard: TV browsers (Fire TV/Silk, Tizen) treat the remote's Back
  // as browser-history back, which would exit /tvapp entirely. While any overlay
  // is open, trap it and close the topmost layer instead.
  const overlayOpen = Boolean(playing || detail || searchOpen);
  useEffect(() => {
    if (!overlayOpen) return;
    history.pushState({ hsTv: true }, "");
    const onPop = () => {
      if (playing) setPlaying(null);
      else if (detail) { setDetail(null); setDInfo(null); }
      else if (searchOpen) { setSearchOpen(false); setResults(null); setQuery(""); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [overlayOpen, playing, detail, searchOpen]);

  // keep focused card visible
  useEffect(() => {
    cardRefs.current[`${focus.r}-${focus.c}`]?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [focus]);  useEffect(() => {
    listRefs.current[listFocus]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [listFocus]);
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus(); // TV browsers pop their on-screen keyboard here
  }, [searchOpen]);
  useEffect(() => {
    resRefs.current[resultFocus]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [resultFocus, results]);

  // ---- detail list model (focusable rows in the modal) ----------------------
  function detailItems() {
    if (!detail) return [];
    const items = [];
    if (detail.kind === "prov" && detail.meta.type === "series") {
      for (const s of dInfo?.seasons || []) {
        for (const ep of s.episodes || []) {
          items.push({ key: `${s.season}-${ep.episode}`, label: `S${String(s.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")} — ${ep.title || "Episode"}`, go: () => play(ep.url, `${detail.meta.name} — S${String(s.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`) });
        }
      }
    }
    if (detail.kind === "prov" && detail.meta.type === "movie" && detail.meta.url) {
      items.push({ key: "prov-play", label: `▶ Play (provider)`, go: () => play(detail.meta.url, detail.meta.title, [], detail.meta.poster) });
    }
    if (detail.kind === "addon" && detail.meta.type === "series" && dInfo?.episodes?.length) {
      // sources follow the picked episode; simplify: first episode's streams
      const first = dInfo.episodes[0];
      const id = `${String(detail.meta.id).split(":")[0]}:${first.season}:${first.episode}`;
      if (dInfo.streams && dInfo.streams.length && dInfo.streamsEp !== id) {
        // streams not for this episode yet — ignore until loaded
      }
    }
    for (const s of dInfo?.streams || []) {
      items.push({ key: `st-${s.url}-${items.length}`, label: `🧲 ${s.addon || "torrent"} · ${s.title || s.name || "stream"}`, go: () => play(s.url, detail.meta.name, (dInfo.streams || []).map((x) => ({ url: x.url })), detail.meta.poster) });
    }
    return items;
  }

  const items = detailItems();
  useEffect(() => { listLen.current = items.length; }, [items.length]);

  // catalog rows load their own items
  const [catItems, setCatItems] = useState({});
  useEffect(() => {
    let dead = false;
    (async () => {
      for (const c of allCatalogs.slice(0, 4)) {
        try {
          const res = await fetch(`/api/addons/catalog?a=${encodeURIComponent(c.addon.id)}&type=${c.type}&cat=${encodeURIComponent(c.id)}&page=1`);
          const out = await res.json();
          if (!dead) setCatItems((cur) => ({ ...cur, [`${c.addon.id}-${c.id}-${c.type}`]: res.ok ? (out.metas || []).slice(0, 40) : [] }));
        } catch {}
      }
    })();
    return () => { dead = true; };
  }, [allCatalogs]);

  const loading = !addons || !vod;

  return (
    <div className="tvApp">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header className="tvTop">
        <span className="tvBrand">HOMESTREAM TV</span>
        <span className="tvHint">◀ ▶ ▲ ▼ browse · ▲ at top = search · OK plays · Back closes</span>
        <button
          className={`tvSearchBtn${searchFocus ? " focus" : ""}`}
          onClick={openSearch}
          onMouseEnter={() => setSearchFocus(true)}
        >
          🔍 Search
        </button>
      </header>

      {playing && (
        <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "#000" }}>
          {/* StreamPlayer lazy-import via dynamic component is avoided; reuse markup:
              the player page logic lives in StreamPlayer component (same folder as home) */}
          <StreamPlayerLazy url={playing.url} sources={playing.sources} title={playing.title} poster={playing.poster} back={() => setPlaying(null)} />
        </div>
      )}

      {!playing && (
        <>
          <div className="tvHero">
            <h1>HomeStream</h1>
            <div className="tvMuted" style={{ marginTop: 6 }}>
              {loading ? "Loading…" : `${(vod?.movies || []).length} movies · ${(vod?.series || []).length} shows · ${(addons || []).length} addons`}
            </div>
          </div>

          {rows.map((row, r) => {
            const rItems = row.kind === "catalog" ? catItems[`${row.c.addon.id}-${row.c.id}-${row.c.type}`] : row.items;
            if (rItems && rItems.length === 0) return null;
            return (
              <section className="tvRow" key={`${row.title}-${r}`}>
                <h3 className="tvRowTitle">{row.title}</h3>
                <div className="tvScroll">
                  {!rItems
                    ? Array.from({ length: 8 }).map((_, i) => <div className="tvCard" key={i}>{noPoster}</div>)
                    : rItems.map((m, c) => (
                        <button
                          className={`tvCard${focus.r === r && focus.c === c ? " focus" : ""}`}
                          key={`${m.id}-${c}`}
                          ref={(el) => (cardRefs.current[`${r}-${c}`] = el)}
                          onClick={() => row.onPick(m)}
                          onMouseEnter={() => setFocus({ r, c })}
                        >
                          {m.poster ? <img src={m.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : noPoster}
                          <div className="tvCardName">{m.name || m.title}</div>
                        </button>
                      ))}
                </div>
              </section>
            );
          })}
        </>
      )}

      {searchOpen && !playing && (
        <div className="tvModal">
          <div className="tvSearchWrap">
            <form onSubmit={(e) => { e.preventDefault(); runSearch(); }}>
              <input
                ref={inputRef}
                className="tvSearchInput"
                placeholder="Search movies & shows…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
              />
            </form>
            {searching && <div className="tvMuted" style={{ marginTop: 14 }}>Searching…</div>}
            <div className="tvResults">
              {(results || []).map((m, i) => (
                <button
                  className={`tvRes${resultFocus === i ? " focus" : ""}`}
                  key={`${m.id}-${i}`}
                  ref={(el) => (resRefs.current[i] = el)}
                  onClick={() => { setSearchOpen(false); openAddonDetail({ ...m, type: m.type || "movie" }); }}
                  onMouseEnter={() => setResultFocus(i)}
                >
                  {m.poster ? <img src={m.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : noPosterSm}
                  <span>
                    <div className="tvResName">{m.name}</div>
                    <div className="tvResMeta">{m.type}{m.releaseInfo ? ` · ${m.releaseInfo}` : ""}</div>
                  </span>
                </button>
              ))}
              {!searching && results && !results.length && (
                <div className="tvMuted">No results for “{query}”</div>
              )}
              {!searching && !results && (
                <div className="tvMuted">Start typing — results appear automatically</div>
              )}
            </div>
            <div className="tvMuted" style={{ marginTop: 12 }}>Back closes search</div>
          </div>
        </div>
      )}

      {detail && !playing && (
        <div className="tvModal" onClick={() => { setDetail(null); setDInfo(null); }}>
          <div className="tvModalBox" onClick={(e) => e.stopPropagation()}>
            <h2>{detail.meta.name || detail.meta.title}</h2>
            <div className="tvModalMeta">
              {detail.meta.year || ""}{detail.meta.rating ? ` · ⭐ ${detail.meta.rating}` : ""}
              {detail.meta.category ? ` · ${detail.meta.category}` : ""}
            </div>
            {dInfo?.desc && <div className="tvModalDesc">{dInfo.desc}</div>}
            {dInfo?.loading && <div className="tvMuted">Loading sources & episodes…</div>}
            {items.map((it, i) => (
              <button
                className={`tvItem${listFocus === i ? " focus" : ""}`}
                key={it.key}
                ref={(el) => (listRefs.current[i] = el)}
                onClick={it.go}
                onMouseEnter={() => setListFocus(i)}
              >
                {it.label}
              </button>
            ))}
            {detail.kind === "prov" && detail.meta.type === "series" && Array.isArray(dInfo?.torrent) && dInfo.torrent.map((s, i) => (
              <button
                className={`tvItem${listFocus === items.length + i ? " focus" : ""}`}
                key={`tr-${i}`}
                ref={(el) => (listRefs.current[items.length + i] = el)}
                onClick={() => play(s.url, detail.meta.name, dInfo.torrent.map((x) => ({ url: x.url })), detail.meta.poster)}
                onMouseEnter={() => setListFocus(items.length + i)}
              >
                🧲 {s.addon || "torrent"} · {s.title || s.name || "stream"}
              </button>
            ))}
            {detail.kind === "prov" && detail.meta.type === "movie" && Array.isArray(dInfo?.torrent) && dInfo.torrent.map((s, i) => (
              <button
                className={`tvItem${listFocus === items.length + i ? " focus" : ""}`}
                key={`trm-${i}`}
                ref={(el) => (listRefs.current[items.length + i] = el)}
                onClick={() => play(s.url, detail.meta.name, dInfo.torrent.map((x) => ({ url: x.url })), detail.meta.poster)}
                onMouseEnter={() => setListFocus(items.length + i)}
              >
                🧲 {s.addon || "torrent"} · {s.title || s.name || "stream"}
              </button>
            ))}
            <div className="tvMuted" style={{ marginTop: 12 }}>Back button closes this</div>
          </div>
        </div>
      )}
    </div>
  );
}

function StreamPlayerLazy(props) {
  return <StreamPlayer {...props} />;
}
