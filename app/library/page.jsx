"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const EXT_COLORS = {
  mp4: ["#3d2f8f", "#6d5cff"],
  mkv: ["#123a5e", "#2d7ff9"],
  avi: ["#4a2e13", "#e08a3c"],
  webm: ["#0f4a3d", "#27c99a"],
  mov: ["#4a1042", "#e0559f"],
  default: ["#28304a", "#5bffb5"],
};

function infoFor(v) {
  const pair = EXT_COLORS[v.ext] || EXT_COLORS.default;
  const hue = (parseInt(v.id.slice(0, 4), 16) % 360) + "deg";
  return { background: `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`, filter: `hue-rotate(${hue})` };
}

function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  return (bytes / 1e6).toFixed(0) + " MB";
}

/** Small label chip: file type, or S01E02 for episodes */
function chipFor(v) {
  return v.kind === "episode" && v.season != null ? `S${String(v.season).padStart(2, "0")}E${v.episode != null ? String(v.episode).padStart(2, "0") : "??"}` : v.ext;
}

function Poster({ v, glyph = "▶" }) {
  // Real poster when TMDB matched; pretty gradient otherwise.
  if (v?.meta?.poster) {
    return (
      <>
        <img src={v.meta.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />
        <span className="ext">{chipFor(v)}</span>
        <span className="play">▶</span>
      </>
    );
  }
  return (
    <>
      <span className="glyph">{glyph}</span>
      <span className="ext">{chipFor(v)}</span>
      <span className="play">▶</span>
    </>
  );
}

function Card({ v, progress }) {
  const pct = progress && v.size ? Math.min(100, Math.round((progress.pos / progress.dur) * 100)) : 0;
  return (
    <Link className="card" href={`/watch?id=${v.id}`} style={v.meta?.poster ? { background: "var(--surface)" } : {}}>
      <div className="poster" style={v.meta?.poster ? { background: "#171b25" } : infoFor(v)}>
        <Poster v={v} />
      </div>
      <div className="meta">
        <div className="t">{v.meta?.poster && v.kind === "episode" ? `${v.show} · S${v.season}E${v.episode ?? "?"}` : v.name}</div>
        <div className="s">
          {v.meta?.year ? `${v.meta.year} · ` : ""}
          {fmtSize(v.size)} · {v.ext.toUpperCase()}
        </div>
        {pct > 0 && <div className="prog"><i style={{ width: pct + "%" }} /></div>}
      </div>
    </Link>
  );
}

export default function HomePage() {
  const [library, setLibrary] = useState(null);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'ok'|'err'|'info', text }
  const [lastWatched, setLastWatched] = useState({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [tmdbKey, setTmdbKey] = useState("");
  const [openShow, setOpenShow] = useState(null); // show title whose episodes are listed
  const [networkSetup, setNetworkSetup] = useState(false); // has network been configured?
  const [lanIp, setLanIp] = useState(""); // saved LAN IP
  const [lanIpTrim, setLanIpTrim] = useState(""); // trimmed LAN IP for UI

  async function loadLibrary() {
    try {
      const res = await fetch("/api/library");
      setLibrary(await res.json());
    } catch {}
  }

  useEffect(() => {
    loadLibrary();
    fetch("/api/settings").then((r) => r.json()).then((d) => {
      setTmdbKey(d.tmdbKey || "");
      setNetworkSetup(d.networkSetup || false);
      setLanIp(d.lanIp || "");
      setLanIpTrim(d.lanIp?.trim() || "");
    }).catch(() => {});
  }, []);

  // Light poll keeps the library fresh after the watch timer's scans.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadLibrary();
    }, 60000);
    return () => clearInterval(t);
  }, []);

  // Resume positions are stored in localStorage by the watch page.
  useEffect(() => {
    try {
      setLastWatched(JSON.parse(localStorage.getItem("hs_progress") || "{}"));
    } catch {}
  }, [library]);

  async function scan(e) {
    if (e) e.preventDefault();
    if (!folder.trim()) return;
    setScanning(true);
    setMessage({ kind: "info", text: "Scanning folder…" });
    const res = await fetch("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    const data = await res.json();
    setScanning(false);
    if (!res.ok) {
      setMessage({ kind: "err", text: data.error || "Scan failed" });
      return;
    }
    const posterNote = data.enriched ? `, ${data.enriched} posters fetched` : "";
    setMessage({ kind: "ok", text: `Added ${data.added} videos${posterNote} — ${data.total} in library.` });
    setFolder("");
    loadLibrary();
  }

  async function rescanAll() {
    setScanning(true);
    setMessage({ kind: "info", text: "Re-scanning all folders…" });
    const res = await fetch("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    });
    const data = await res.json();
    setScanning(false);
    if (!res.ok) setMessage({ kind: "err", text: data.error || "Rescan failed" });
    else setMessage({ kind: "ok", text: `Library refreshed — ${data.videos} videos${data.enriched ? `, ${data.enriched} posters added` : ""}.` });
    loadLibrary();
  }

  async function removeFolder(f) {
    const res = await fetch("/api/library", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder: f }) });
    if (res.ok) loadLibrary();
  }

  async function saveKey(e) {
    e.preventDefault();
    if (!tmdbKey.trim()) return;
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbKey }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage({ kind: "err", text: data.error || "Couldn't save the key" });
      return;
    }
    setMessage({ kind: "ok", text: "TMDB key saved — filling in posters and descriptions in the background…" });
    loadLibrary();
    setTimeout(rescanAll, 1200);
  }

  async function setupNetwork(e) {
    e.preventDefault();
    const ip = lanIpTrim.trim();
    if (!ip) {
      setMessage({ kind: "err", text: "Enter a LAN IP address first" });
      return;
    }
    setScanning(true);
    setMessage({ kind: "info", text: "Saving network configuration…" });
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setup-network", ip }),
    });
    const data = await res.json();
    setScanning(false);
    if (!res.ok) {
      setMessage({ kind: "err", text: data.error || "Failed to save network" });
      return;
    }
    setNetworkSetup(true);
    setLanIp(data.lanIp || ip);
    setLanIpTrim(data.lanIp?.trim() || ip);
    setMessage({ kind: "ok", text: `Network saved — ${lanIpTrim} configured. Devices on this Wi-Fi can now open the app.` });
  }

  async function clearNetwork() {
    fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear-network" }) })
      .then(() => {
        setNetworkSetup(false);
        setLanIp("");
        setLanIpTrim("");
        window.location.reload();
      })
      .catch(() => window.location.reload());
  }

  const videos = useMemo(() => {
    if (!library) return [];
    const q = query.trim().toLowerCase();
    return library.videos.filter((v) => !q || v.name.toLowerCase().includes(q));
  }, [library, query]);

  // TV shows collected from episode files, jellyfin-style.
  const shows = useMemo(() => {
    const map = new Map();
    for (const v of library?.videos || []) {
      if (v.kind !== "episode" || !v.show) continue;
      let s = map.get(v.show);
      if (!s) {
        s = { title: v.show, episodes: [], poster: null };
        map.set(v.show, s);
      }
      s.episodes.push(v);
      if (v.meta?.poster && !s.poster) s.poster = v.meta.poster;
    }
    return [...map.values()]
      .map((s) => ({
        ...s,
        episodes: s.episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [library]);

  const movies = useMemo(() => videos.filter((v) => v.kind !== "episode"), [videos]);

  const continueRow = useMemo(
    () => videos.filter((v) => lastWatched[v.id] && lastWatched[v.id].pos > 15).slice(0, 8),
    [videos, lastWatched]
  );

  const searching = query.trim().length > 0;

  if (!library) {
    return (
      <div className="shell">
        <div className="main" style={{ paddingTop: 40, color: "var(--muted)" }}>Loading library…</div>
      </div>
    );
  }

  return (
    <div className={`shell${menuOpen ? " nav-open" : ""}`}>
      {menuOpen && <div className="navOverlay" onClick={() => setMenuOpen(false)} />}
      <aside className="side">
        <div className="brand">Home<span>Stream</span></div>
        <nav>
          <a href="/">🍿 Home</a>
          <a href="/library">🎬 Library</a>
          <a href="/tv">📺 Live TV</a>
          <a href="/guide">🗓️ Guide</a>
          <a href="/vod">🍿 Movies & TV</a>
          <a href="/addons">🧩 Addons</a>
          <a href="/" onClick={(e) => { e.preventDefault(); setMenuOpen(false); document.getElementById("add")?.scrollIntoView({ behavior: "smooth" }); }}>➕ Add videos</a>
        </nav>
        {library.lanUrl && (
          <div className="notice" style={{ margin: "24px 0 0" }}>
            📱 Phone on this Wi-Fi?<br />
            <a href={library.lanUrl}>{library.lanUrl}</a>
          </div>
        )}
        <div className="notice" style={{ margin: "16px 0 0", fontSize: 11.5, opacity: 0.75 }}>
          🕒 Watch folders rescan every 10 min — new files appear automatically.
        </div>
      </aside>

      <main className="main">
        <div className="head">
          <button className="menuBtn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>☰</button>
          <h1>Library</h1>
          <input
            className="search"
            placeholder={`Search ${library.videos.length} videos…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {message && (
          <div className="notice" style={message.kind === "err" ? { color: "#ff8f8f", borderColor: "#46242a" } : undefined}>
            {message.text}
          </div>
        )}

        <section className="panel" id="add">
          <h3>Add a video folder</h3>
          <p>Point HomeStream at any folder (e.g. <code>D:\Movies</code> or <code>D:\Media\TV Shows</code>). Files are found in subfolders too, S01E01-style names are turned into TV shows.</p>
          <form className="row" onSubmit={scan}>
            <input
              className="input"
              placeholder="D:\Movies"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              spellCheck={false}
            />
            <button
              className="btn"
              type="button"
              style={{ marginLeft: 8 }}
              onClick={async () => {
                try {
                  const dir = await window.showDirectoryPicker();
                  const path = Array.from(dir.entries())[0][0];
                  setFolder(path);
                } catch {
                  setMessage({
                    kind: "info",
                    text:
                      "Directory picker not supported on this device. Type the folder path manually (e.g. D:\\Movies).",
                  });
                }
              }}
              disabled={scanning || folder.trim().length > 0}
              aria-label="Browse folder"
            >
              Browse
            </button>
            <button className="btn" type="submit" disabled={scanning || !folder.trim()}>
              {scanning ? "Scanning…" : "Scan folder"}
            </button>
            <button className="btn ghost" type="button" disabled={scanning || library.folders.length === 0} onClick={rescanAll}>
              🔄 Rescan all
            </button>
          </form>
          {library.folders.length > 0 && (
            <div>
              {library.folders.map((f) => (
                <span className="tag" key={f}>
                  📁 {f}
                  <button title="Remove from library" onClick={() => removeFolder(f)}>✕</button>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* TMDB metadata settings */}
        <section className="panel">
          <h3>🎬 Posters & descriptions (TMDB)</h3>
          <p>
            Paste a free TMDB API key to turn filenames into real posters, years and descriptions.
            Get one in 2 minutes: <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer">themoviedb.org/signup</a> → Settings → API → Request an API key → copy the <b>API Key (v3)</b>.
          </p>
          <form className="row" onSubmit={saveKey}>
            <input
              className="input"
              placeholder="TMDB API key (v3)"
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn" type="submit" disabled={!tmdbKey.trim()}>Save key</button>
          </form>
        </section>

        {/* Network setup flow */}
        <section className="panel" style={{ marginTop: 12 }}>
          <h3>📱 Network Setup</h3>
          <p>
            This app works on any device connected to the same Wi-Fi as your PC.
            Run this once to save your network address for automatic future access.
          </p>
          {networkSetup ? (
            <div>
              <p style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                ✅ Network configured — IP saved: <code>{lanIp ?? "unknown"}</code>
              </p>
              <p style={{ fontSize: 12, opacity: 0.8 }}>
                Devices on this Wi-Fi can now open <code>http://{lanIp ?? "your-IP"}:3000</code>
                automatically.{TmrState ? " (Tailscale also works from anywhere)" : ""}
              </p>
              <button
                className="btn ghost"
                style={{ width: "100%" }}
                onClick={() => {
                  // Clear network setup and reload
                  fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear-network" }) })
                    .then(() => window.location.reload())
                    .catch(() => window.location.reload());
                }}
              >
                🔄 Reset network setup
              </button>
            </div>
          ) : (
            <form className="row" onSubmit={setupNetwork}>
              <input
                className="input"
                type="text"
                placeholder="192.168.1.XX (your PC's LAN IP)"
                value={lanIp || ""}
                onChange={(e) => setLanIp(e.target.value)}
                spellCheck={false}
                autoFocus
              />
              <button
                className="btn"
                type="submit"
                disabled={scanning || !lanIpTrim.trim()}
              >
                📡 Save Network
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  // Generate QR code and show it
                  const url = lanIpTrim ? `http://${lanIpTrim}:3000` : "";
                  if (!url) {
                    setMessage({ kind: "err", text: "Enter a LAN IP first" });
                    return;
                  }
                  // Generate QR code data URL (simple approach)
                  const qrData = `http://${lanIpTrim}:3000`;
                  const el = document.createElement("img");
                  el.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
                    qrData
                  )}`;
                  el.style.width = "200px";
                  el.style.height = "200px";
                  el.style.marginTop = "8px";
                  setMessage({
                    kind: "ok",
                    text: "Scan QR code with your phone camera",
                    qrCode: el.outerHTML,
                  });
                }}
              >
                📱 Show QR Code
              </button>
            </form>
          )}
        </section>

        {continueRow.length > 0 && !searching && (
          <section className="hrow">
            <h2>▶ Continue watching</h2>
            <div className="grid" style={{ marginTop: 12 }}>
              {continueRow.map((v) => (
                <div key={v.id} style={{ position: "relative" }}>
                  <Card v={v} progress={lastWatched[v.id]} />
                  <span
                    role="button"
                    aria-label="Remove from Continue Watching"
                    onClick={() => {
                      const raw = JSON.parse(localStorage.getItem("hs_progress") || "{}");
                      delete raw[v.id];
                      localStorage.setItem("hs_progress", JSON.stringify(raw));
                      setLastWatched({ ...raw });
                    }}
                    style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,.6)", borderRadius: "50%", width: 22, height: 22, lineHeight: "22px", fontSize: 12, textAlign: "center", cursor: "pointer", zIndex: 2 }}
                  >✕</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {shows.length > 0 && !searching && (
          <section className="hrow" style={{ marginTop: continueRow.length ? 10 : 0 }}>
            <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>TV Shows ({shows.length})</h2>
            {openShow ? (
              <div className="panel" style={{ marginTop: 10 }}>
                <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                  {openShow.poster
                    ? <img src={openShow.poster} alt="" style={{ width: 140, borderRadius: 8 }} onError={(e) => (e.currentTarget.style.display = "none")} />
                    : <div style={{ width: 140, borderRadius: 8, background: "#171b25", aspectRatio: "2/3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 40 }}>📺</div>}
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <button className="btn ghost" onClick={() => setOpenShow(null)}>← All shows</button>
                    <h2 style={{ margin: "10px 0 8px" }}>{openShow.title}</h2>
                    <div className="epList">
                      {openShow.episodes.map((ep) => (
                        <Link
                          key={ep.id}
                          className="ep"
                          href={`/watch?id=${ep.id}`}
                          onClick={() => setOpenShow(null)}
                        >
                          ▶ {ep.episode != null ? `${ep.season}×${String(ep.episode).padStart(2, "0")} — ` : ""}{ep.name}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid" style={{ marginTop: 12 }}>
                {shows.map((s) => (
                  <button className="card vodCard" key={s.title} onClick={() => setOpenShow(s)}>
                    <div className="poster" style={{ background: "#171b25", aspectRatio: "2/3" }}>
                      {s.poster
                        ? <img src={s.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />
                        : <span className="glyph">📺</span>}
                      <span className="ext">{s.episodes.length} ep</span>
                    </div>
                    <div className="meta">
                      <div className="t">{s.title}</div>
                      <div className="s">{s.episodes.length} episode{s.episodes.length === 1 ? "" : "s"}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="hrow" style={{ marginTop: shows.length ? 10 : 0 }}>
          <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>
            {searching ? `Results for “${query}” (${videos.length})` : `Videos (${movies.length})`}
          </h2>
          {videos.length === 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="empty" style={{ maxWidth: 560, margin: "0 auto" }}>
                {library.folders.length === 0
                  ? "No folders yet — add one above to fill your library."
                  : searching ? "Nothing matches that search." : "No video files found in your folders."}
              </div>
            </div>
          ) : (
            <div className="grid" style={{ marginTop: 12 }}>
              {(searching ? videos : movies).map((v) => <Card key={v.id} v={v} progress={lastWatched[v.id]} />)}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
