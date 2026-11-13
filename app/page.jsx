"use client";

import Link from "next/link";
import StreamPlayer from "./components/StreamPlayer";
import ContinueRow from "./components/ContinueRow";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Netflix-style home for HomeStream ("Discover"):
 *  - fixed top nav with a global search
 *  - hero billboard
 *  - horizontally scrolling poster rows: addon catalogs + provider VOD
 *  - Stremio-style detail: merged sources (provider streams first, then
 *    Torrentio torrent sources found by title→IMDb lookup)
 *  - plays through the shared StreamPlayer (movie-style, ephemeral torrents)
 */

const CSS = `
.nf { background:#141414; min-height:100vh; color:#fff; }
.nfTop { position:sticky; top:0; z-index:30; display:flex; align-items:center; gap:18px;
  padding:10px 4%; background:linear-gradient(180deg, rgba(0,0,0,.88), rgba(0,0,0,.55)); }
.nfBrand { color:#e50914; font-weight:900; font-size:22px; letter-spacing:1px; text-decoration:none; }
.nfNav { display:flex; gap:16px; flex-wrap:wrap; }
.nfNav a { color:#ddd; font-size:13.5px; text-decoration:none; }
.nfNav a:hover, .nfNav a.on { color:#fff; font-weight:700; }
.nfSearch { margin-left:auto; }
.nfSearch input { width:210px; background:rgba(0,0,0,.65); border:1px solid #555; color:#fff;
  padding:7px 12px; border-radius:4px; font-size:13px; outline:none; }
.nfSearch input:focus { border-color:#999; }
.nfHero { position:relative; min-height:62vh; display:flex; align-items:flex-end; }
.nfHeroBg { position:absolute; inset:0; background-size:cover; background-position:center 20%; }
.nfHeroFade { position:absolute; inset:0;
  background:linear-gradient(90deg, rgba(20,20,20,.96) 0%, rgba(20,20,20,.55) 45%, transparent 75%),
             linear-gradient(0deg, #141414 2%, transparent 55%); }
.nfHeroInner { position:relative; padding:0 4% 6vh; max-width:620px; }
.nfHeroInner h1 { font-size:42px; font-weight:900; margin:0 0 6px; text-shadow:0 2px 8px rgba(0,0,0,.8); }
.nfHeroMeta { color:#ddd; font-size:13.5px; margin-bottom:8px; }
.nfHeroDesc { color:#e8e8e8; font-size:15px; line-height:1.5; margin-bottom:14px;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.nfBtn { display:inline-flex; align-items:center; gap:8px; border:none; cursor:pointer;
  font-weight:700; font-size:15px; padding:10px 24px; border-radius:4px; margin-right:10px; }
.nfBtn.play { background:#fff; color:#111; }
.nfBtn.info { background:rgba(109,109,110,.7); color:#fff; }
.nfBtn:hover { filter:brightness(1.15); }
.nfRow { margin:10px 0 26px; }
.nfRowTitle { font-size:19px; font-weight:800; margin:0 0 8px; padding:0 4%; }
.nfScroll { display:flex; gap:8px; overflow-x:auto; padding:4px 4% 14px; scrollbar-width:none; }
.nfScroll::-webkit-scrollbar { display:none; }
.nfCard { flex:0 0 auto; width:152px; background:none; border:none; cursor:pointer; text-align:left;
  color:#fff; padding:0; transition:transform .18s ease; position:relative; }
.nfCard:hover { transform:scale(1.07); z-index:2; }
.nfCard img { width:100%; aspect-ratio:2/3; object-fit:cover; border-radius:4px; background:#26262a; display:block; }
.nfCardName { font-size:12px; color:#ccc; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.nfGrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:12px; padding:4px 4% 30px; }
.nfGrid .nfCard { width:auto; }
.nfModal { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.8); overflow-y:auto; padding:24px 12px 60px; }
.nfModalBox { max-width:840px; margin:0 auto; background:#181818; border-radius:10px; overflow:hidden;
  box-shadow:0 20px 80px rgba(0,0,0,.9); }
.nfModalHero { position:relative; height:380px; background-size:cover; background-position:center 20%; }
.nfModalHeroFade { position:absolute; inset:0; background:linear-gradient(0deg, #181818 2%, transparent 60%); }
.nfModalClose { position:absolute; top:12px; right:12px; background:rgba(20,20,20,.85); border:none;
  color:#fff; width:34px; height:34px; border-radius:50%; font-size:16px; cursor:pointer; z-index:2; }
.nfModalBody { padding:0 32px 30px; }
.nfModalBody h2 { font-size:28px; font-weight:900; margin:0 0 6px; }
.nfModalMeta { color:#bbb; font-size:13.5px; margin-bottom:10px; }
.nfModalDesc { color:#ddd; font-size:14.5px; line-height:1.55; max-width:640px; }
.nfSection { margin-top:20px; }
.nfSection h3 { font-size:16px; font-weight:800; margin:0 0 8px; }
.nfSrc { display:block; width:100%; text-align:left; background:#232323; border:1px solid #333;
  color:#fff; padding:10px 14px; border-radius:6px; margin:7px 0; cursor:pointer; font-size:13.5px; }
.nfSrc:hover { background:#303030; border-color:#555; }
.nfEp { display:inline-block; background:#232323; border:1px solid #333; color:#fff;
  padding:7px 12px; border-radius:6px; margin:4px 6px 4px 0; cursor:pointer; font-size:12.5px; }
.nfEp:hover { background:#303030; }
.nfEp.on { border-color:#e50914; font-weight:700; }
.nfMuted { color:#999; font-size:13px; }
.nfSeasons { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
.nfSeasonBtn { background:#232323; border:1px solid #333; color:#fff; padding:7px 14px; border-radius:6px; cursor:pointer; font-size:13px; }
.nfSeasonBtn.on { border-color:#e50914; font-weight:700; }
.nfLoading { color:#999; padding:30px 4%; font-size:14px; }
@media (max-width: 760px) {
  .nfHeroInner h1 { font-size:28px; }
  .nfModalHero { height:250px; }
  .nfModalBody { padding:0 18px 24px; }
  .nfNav { display:none; }
  .nfSearch input { width:130px; }
}
`;

const noPoster = (label = "🎬") => (
  <div style={{ width: "100%", aspectRatio: "2/3", borderRadius: 4, background: "#26262a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34 }}>
    {label}
  </div>
);

function Row({ title, items, onPick, nameKey = "name" }) {
  if (!items?.length) return null;
  return (
    <section className="nfRow">
      <h3 className="nfRowTitle">{title}</h3>
      <div className="nfScroll">
        {items.map((m, i) => (
          <button className="nfCard" key={`${m.id}-${i}`} onClick={() => onPick(m)} title={m[nameKey] || m.title}>
            {m.poster ? <img src={m.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : noPoster()}
            <div className="nfCardName">{m[nameKey] || m.title}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

/** One installed addon catalog as its own scrolling row. Self-fetching. */
function CatalogRow({ addon, cat, onPick }) {
  const [metas, setMetas] = useState(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch(`/api/addons/catalog?a=${encodeURIComponent(addon.id)}&type=${cat.type}&cat=${encodeURIComponent(cat.id)}&page=1`);
        const out = await res.json();
        if (!dead) setMetas(res.ok ? out.metas.slice(0, 40) : []);
      } catch { if (!dead) setMetas([]); }
    })();
    return () => { dead = true; };
  }, [addon.id, cat.type, cat.id]);
  if (metas && metas.length === 0) return null;
  return (
    <section className="nfRow">
      <h3 className="nfRowTitle">{addon.name} · {cat.name}</h3>
      <div className="nfScroll">
        {!metas
          ? Array.from({ length: 8 }).map((_, i) => <div className="nfCard" key={i}>{noPoster()}</div>)
          : metas.map((m) => (
              <button className="nfCard" key={m.id} onClick={() => onPick(m)} title={m.name}>
                {m.poster ? <img src={m.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : noPoster()}
                <div className="nfCardName">{m.name}</div>
              </button>
            ))}
      </div>
    </section>
  );
}

export default function NetflixHome() {
  const [addons, setAddons] = useState(null);
  const [vod, setVod] = useState(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null); // null = off
  const [searching, setSearching] = useState(false);
  const [detail, setDetail] = useState(null);    // {kind:'addon'|'prov', meta}
  const [dInfo, setDInfo] = useState(null);     // {desc, streams, seasons, episodes, ...}
  const [playing, setPlaying] = useState(null); // {url, sources, title, poster}
  const [cwKey, setCwKey] = useState(0);
  const searchTimer = useRef(null);

  useEffect(() => {
    fetch("/api/addons").then((r) => r.json()).then((d) => setAddons(d.addons || [])).catch(() => setAddons([]));
    fetch("/api/vod")
      .then((r) => r.json())
      .then((d) => {
        setVod(d);
        if (!d.movies?.length && !d.series?.length) return fetch("/api/vod?refresh=1").then((r) => r.json()).then(setVod).catch(() => {});
      })
      .catch(() => setVod({ movies: [], series: [] }));
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

  const hero = useMemo(() => provMovies.find((m) => m.poster) || provSeries.find((m) => m.poster) || null, [provMovies, provSeries]);

  // Global search: addons (IMDb-backed) + your provider catalog, merged.
  useEffect(() => {
    clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      let addonHits = [];
      try {
        const res = await fetch(`/api/addons/search?q=${encodeURIComponent(q)}`);
        if (res.ok) addonHits = (await res.json()).metas || [];
      } catch {}
      const needle = q.toLowerCase();
      const provHits = [
        ...(vod?.movies || []), ...(vod?.series || []),
      ].filter((x) => x.title?.toLowerCase().includes(needle))
        .map((x) => ({ ...x, kind: x.category && x.episodeCount !== undefined ? "series" : (x.episodes !== undefined ? "series" : (x.category && x.season ? "series" : "movie")), name: x.title }));
      // merge, dedupe by normalized name
      const seen = new Set();
      const merged = [];
      for (const m of [...addonHits, ...provHits]) {
        const k = (m.name || m.title || "").toLowerCase().replace(/\W+/g, " ");
        if (k && !seen.has(k)) { seen.add(k); merged.push(m); }
      }
      setSearchResults(merged);
      setSearching(false);
    }, 450);
    return () => clearTimeout(searchTimer.current);
  }, [query, vod]);

  // ---- detail opening -------------------------------------------------------
  function openAddonDetail(m) {
    const type = m.type || (String(m.id).startsWith("tt") ? "movie" : "movie");
    setDetail({ kind: "addon", meta: { ...m, type } });
    setDInfo({ loading: true, streams: null, episodes: null, desc: m.description || "" });
    openAddonBody(m, type);
  }

  async function openAddonBody(m, type) {
    const [streams, meta] = await Promise.all([
      loadStreamsAll(type, m.id),
      (!m.description || type === "series")
        ? fetch(`/api/addons/meta?a=com.linvo.cinemeta&type=${type}&id=${encodeURIComponent(m.id)}`).then((r) => r.json()).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (type === "series") {
      const vids = (meta?.meta?.videos || []).filter((v) => v.season > 0);
      setDInfo((d) => ({ ...d, loading: false, streams, episodes: vids, desc: meta?.meta?.description || d.desc }));
    } else {
      setDInfo((d) => ({ ...d, loading: false, streams, desc: meta?.meta?.description || d.desc }));
    }
  }

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

  // Stremio's trick for provider titles (no IMDb id): search Cinemeta by name,
  // then ask the torrent addons for streams of the matched IMDb id.
  async function torrentSourcesFor(title, type) {
    try {
      const res = await fetch(`/api/addons/search?q=${encodeURIComponent(title)}`);
      const metas = res.ok ? (await res.json()).metas || [] : [];
      const hit = metas.find((x) => /^tt\d+/.test(String(x.id)) && (!type || x.type === type))
        || metas.find((x) => /^tt\d+/.test(String(x.id)));
      if (!hit) return [];
      return loadStreamsAll(hit.type || type || "movie", hit.id);
    } catch { return []; }
  }

  function openProviderDetail(m) {
    const isSeries = m.kind === "series" || m.episodes !== undefined || (m.category && !m.url);
    if (!isSeries && m.url) {
      // movie: straight to a Netflix-style detail with Play + torrent lookup
      setDetail({ kind: "prov", meta: { ...m, type: "movie", name: m.title } });
      setDInfo({ loading: true, streams: null, torrent: "pending", desc: "" });
      torrentSourcesFor(m.title, "movie").then((t) => setDInfo((d) => ({ ...d, loading: false, torrent: t })));
      return;
    }
    // series: fetch seasons/episodes with playable urls + torrent lookup
    setDetail({ kind: "prov", meta: { ...m, type: "series", name: m.title } });
    setDInfo({ loading: true, streams: null, torrent: "pending", seasons: null, season: null, desc: "" });
    torrentSourcesFor(m.title, "series").then((t) => setDInfo((d) => ({ ...d, torrent: t })));
    fetch(`/api/vod/series?prov=${encodeURIComponent(m.prov)}&id=${encodeURIComponent(m.id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { setDInfo((d) => ({ ...d, loading: false, seasons: [], error: j.error })); return; }
        setDInfo((d) => ({
          ...d, loading: false,
          seasons: j.seasons || [],
          season: (j.seasons || [])[0] || null,
          desc: j.overview || "",
          poster: j.poster || m.poster,
        }));
      })
      .catch(() => setDInfo((d) => ({ ...d, loading: false, seasons: [], error: "Couldn't load this series" })));
  }

  function openItem(m) {
    setPlaying(null);
    if (m.prov) {
      // provider items carry title, not name — normalize for the modal
      openProviderDetail({ ...m, name: m.title });
    } else {
      openAddonDetail(m);
    }
  }

  function pickAddonEpisode(v) {
    const id = `${String(detail.meta.id).split(":")[0]}:${v.season}:${v.episode}`;
    setDInfo((d) => ({ ...d, selEp: id, streams: null }));
    loadStreamsAll("series", id).then((streams) => setDInfo((d) => ({ ...d, streams })));
  }

  function playAddon(s) {
    setPlaying({
      url: s.url,
      sources: (dInfo?.streams || []).map((x) => ({ url: x.url, label: x.addon === s.addon ? "" : x.addon })),
      title: detail.meta.name,
      poster: detail.meta.poster || "",
    });
  }

  function playProviderMovie(m) {
    setPlaying({ url: m.url, sources: [], title: m.title, poster: m.poster || "" });
  }

  function playProviderEpisode(ep) {
    setPlaying({
      url: ep.url,
      sources: [],
      title: `${detail.meta.name} — S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}${ep.title ? ` · ${ep.title}` : ""}`,
      poster: dInfo?.poster || detail.meta.poster || "",
    });
  }

  function closeDetail() { setDetail(null); setDInfo(null); }

  const showSearch = query.trim().length > 0;
  const loading = !addons || !vod;

  return (
    <div className="nf">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <header className="nfTop">
        <Link className="nfBrand" href="/">HOMESTREAM</Link>
        <nav className="nfNav">
          <Link className="on" href="/">Home</Link>
          <Link href="/library">Library</Link>
          <Link href="/tv">Live TV</Link>
          <Link href="/guide">Guide</Link>
          <Link href="/addons">Addons</Link>
        </nav>
        <div className="nfSearch">
          <input
            placeholder="🔍 Titles, shows, movies…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </header>

      {playing && (
        <div style={{ padding: "12px 4% 30px" }}>
          <StreamPlayer
            url={playing.url}
            sources={playing.sources}
            title={playing.title}
            poster={playing.poster || ""}
            back={() => { setPlaying(null); setCwKey((k) => k + 1); }}
          />
        </div>
      )}

      {!playing && !showSearch && (
        <>
          {hero && (
            <div className="nfHero">
              <div className="nfHeroBg" style={{ backgroundImage: `url(${hero.poster})` }} />
              <div className="nfHeroFade" />
              <div className="nfHeroInner">
                <h1>{hero.title || hero.name}</h1>
                <div className="nfHeroMeta">
                  {hero.year ? `${hero.year}` : ""}{hero.rating ? ` · ⭐ ${Number(hero.rating).toFixed?.(1) || hero.rating}` : ""}
                  {hero.category ? ` · ${hero.category}` : ""}
                </div>
                {hero.description && <div className="nfHeroDesc">{hero.description}</div>}
                <button className="nfBtn play" onClick={() => openItem(hero)}>▶ Play</button>
                <button className="nfBtn info" onClick={() => openItem(hero)}>ⓘ More Info</button>
              </div>
            </div>
          )}

          <div style={{ marginTop: hero ? -8 : 12 }}>
            <ContinueRow refreshKey={cwKey} onSelect={(x) => setPlaying({ url: x.id, title: x.title, poster: x.poster })} />
            {(addons || []).length === 0 && (
              <div className="nfLoading">
                No addons installed yet — <Link href="/addons" style={{ color: "#e50914", fontWeight: 700 }}>install Cinemeta + Torrentio</Link> for full catalogs and torrent sources.
              </div>
            )}
            {allCatalogs.slice(0, 6).map((c, i) => (
              <CatalogRow key={i} addon={c.addon} cat={{ type: c.type, id: c.id, name: c.name }} onPick={openItem} />
            ))}
            <Row title="Movies" items={provMovies} onPick={openItem} nameKey="title" />
            <Row title="TV Shows" items={provSeries} onPick={openItem} nameKey="title" />
            {loading && <div className="nfLoading">Loading your library…</div>}
          </div>
        </>
      )}

      {!playing && showSearch && (
        <section style={{ marginTop: 14 }}>
          <h3 className="nfRowTitle">{searching ? "Searching…" : `Results for “${query.trim()}”`}</h3>
          {!searching && searchResults?.length === 0 && (
            <div className="nfLoading">Nothing found across addons or your provider.</div>
          )}
          <div className="nfGrid">
            {(searchResults || []).map((m, i) => (
              <button className="nfCard" key={`${m.id}-${i}`} onClick={() => openItem(m)} title={m.name || m.title}>
                {m.poster ? <img src={m.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : noPoster()}
                <div className="nfCardName">{m.name || m.title}</div>
                {(m.year || m.rating) && <div style={{ fontSize: 11, color: "#888" }}>{m.year || ""}{m.rating ? ` · ⭐ ${m.rating}` : ""}</div>}
              </button>
            ))}
          </div>
        </section>
      )}

      {detail && !playing && (
        <div className="nfModal" onClick={closeDetail}>
          <div className="nfModalBox" onClick={(e) => e.stopPropagation()}>
            <div className="nfModalHero" style={{ backgroundImage: `url(${dInfo?.poster || detail.meta.poster || ""})` }}>
              <div className="nfModalHeroFade" />
              <button className="nfModalClose" onClick={closeDetail} aria-label="Close">✕</button>
              <div style={{ position: "absolute", left: 32, bottom: 18, right: 32 }}>
                <h2 style={{ margin: 0, fontSize: 30, fontWeight: 900, textShadow: "0 2px 8px rgba(0,0,0,.8)" }}>{detail.meta.name || detail.meta.title}</h2>
                {detail.kind === "prov" && detail.meta.type === "movie" && detail.meta.url && (
                  <button className="nfBtn play" style={{ marginTop: 10 }} onClick={() => playProviderMovie(detail.meta)}>▶ Play</button>
                )}
              </div>
            </div>
            <div className="nfModalBody">
              <div className="nfModalMeta">
                {detail.meta.year ? `${detail.meta.year}` : ""}
                {detail.meta.rating ? ` · ⭐ ${Number(detail.meta.rating).toFixed?.(1) || detail.meta.rating}` : ""}
                {detail.meta.category ? ` · ${detail.meta.category}` : ""}
                {detail.kind === "addon" ? " · via addons" : " · your provider"}
              </div>
              {dInfo?.desc && <div className="nfModalDesc">{dInfo.desc}</div>}
              {dInfo?.error && <div className="nfMuted" style={{ marginTop: 8 }}>⚠️ {dInfo.error}</div>}

              {/* provider series: season selector + episode list */}
              {detail.kind === "prov" && detail.meta.type === "series" && (
                <div className="nfSection">
                  <h3>Episodes</h3>
                  {!dInfo?.seasons && <div className="nfMuted">Loading episodes…</div>}
                  {dInfo?.seasons?.length > 0 && (
                    <>
                      <div className="nfSeasons">
                        {dInfo.seasons.map((s) => (
                          <button
                            key={s.season}
                            className={`nfSeasonBtn${dInfo.season?.season === s.season ? " on" : ""}`}
                            onClick={() => setDInfo((d) => ({ ...d, season: s }))}
                          >
                            Season {s.season}
                          </button>
                        ))}
                      </div>
                      {(dInfo.season?.episodes || []).map((ep) => (
                        <button className="nfSrc" key={ep.episode} onClick={() => playProviderEpisode(ep)}>
                          ▶ S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")} — {ep.title || "Episode"}{ep.plot ? ` · ${String(ep.plot).slice(0, 70)}…` : ""}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}

              {/* addon detail: episode picker for series */}
              {detail.kind === "addon" && detail.meta.type === "series" && dInfo?.episodes?.length > 0 && (
                <div className="nfSection">
                  <h3>Episodes</h3>
                  <div style={{ maxHeight: 190, overflowY: "auto" }}>
                    {dInfo.episodes.map((v) => (
                      <button
                        key={v.id}
                        className={`nfEp${dInfo.selEp === `${String(detail.meta.id).split(":")[0]}:${v.season}:${v.episode}` ? " on" : ""}`}
                        onClick={() => pickAddonEpisode(v)}
                      >
                        S{String(v.season).padStart(2, "0")}E{String(v.episode).padStart(2, "0")} {v.name ? `· ${v.name}` : ""}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* sources */}
              {detail.kind === "addon" && (
                <div className="nfSection">
                  <h3>Sources</h3>
                  {dInfo?.streams == null || dInfo?.loading ? (
                    <div className="nfMuted">🔎 Checking installed addons for sources…</div>
                  ) : dInfo.streams.length === 0 ? (
                    <div className="nfMuted">No sources for this title right now.</div>
                  ) : (
                    dInfo.streams.map((s, i) => (
                      <button className="nfSrc" key={i} onClick={() => playAddon(s)}>
                        🎞️ {s.addon || "source"} · {s.title || s.name || "stream"}
                      </button>
                    ))
                  )}
                </div>
              )}

              {/* provider movie/series: torrent sources via title lookup */}
              {detail.kind === "prov" && (
                <div className="nfSection">
                  <h3>Torrent sources</h3>
                  {dInfo?.torrent === "pending" && <div className="nfMuted">🔎 Looking for torrent sources…</div>}
                  {Array.isArray(dInfo?.torrent) && dInfo.torrent.length === 0 && (
                    <div className="nfMuted">No torrent sources found — provider streams above work right away.</div>
                  )}
                  {Array.isArray(dInfo?.torrent) && dInfo.torrent.map((s, i) => (
                    <button
                      className="nfSrc" key={i}
                      onClick={() => setPlaying({ url: s.url, sources: dInfo.torrent.map((x) => ({ url: x.url })), title: detail.meta.name, poster: detail.meta.poster || "" })}
                    >
                      🧲 {s.addon || "torrent"} · {s.title || s.name || "stream"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && !playing && <div className="nfLoading" style={{ padding: "20px 4%" }}>Loading…</div>}
    </div>
  );
}
