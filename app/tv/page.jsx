"use client";

import Link from "next/link";
import Hls from "hls.js";
import PipButton from "../components/PipButton";
import { useEffect, useMemo, useRef, useState } from "react";

const FAIL_WINDOW = 30 * 60 * 1000; // a channel counts as "dead" for 30 min after failing
const MAX_AUTO_SKIPS = 5;

const HLS_RE = /\.(m3u8)/i;
const TS_RE = /\.ts(\?|$)|\.ts$/i;

/**
 * Every channel gets an ordered list of playback attempts:
 *  1. its own URL (HLS via hls.js, or native <video>)
 *  2. for .ts channels: the same stream requested as .m3u8 (Xtream providers
 *     almost always serve the HLS variant on the same path)
 *  3. server-side transcode — ffmpeg converts anything to browser-friendly H.264
 */
function buildCandidates(ch) {
  const url = ch.url;
  const cands = [];
  const push = (u, engine, label) => cands.push({ url: u, engine, label });
  // Server-side HLS restream: real live segments from ffmpeg — this is the
  // native, smooth path for iPhones (and any player without MSE).
  const restream = `/api/tv/transcode?u=${encodeURIComponent(url)}&f=hls`;
  const transcode = `/api/tv/transcode?u=${encodeURIComponent(url)}`;

  if (HLS_RE.test(url)) {
    push(url, "hls", "");
  } else if (TS_RE.test(url)) {
    push(url.replace(/\.ts(\?|$)/i, ".m3u8$1"), "hls", "");
    push(restream, "restream", "Converting stream…");
    push(transcode, "native", "Converting stream…");
  } else if (/\.(mp4|mov|m4v)$/i.test(url)) {
    push(url, "native", "");
    push(restream, "restream", "Converting stream…");
    push(transcode, "native", "Converting stream…");
  } else {
    // mkv, flv, weird things — browser may cope, restream is the net
    push(url, "native", "");
    push(restream, "restream", "Converting stream…");
    push(transcode, "native", "Converting stream…");
  }
  return cands;
}

function beautyUrl(u) {
  try {
    return new URL(u).host;
  } catch {
    return u.slice(0, 40);
  }
}

function isRecentlyFailed(meta, url) {
  const rec = meta[url];
  return rec && Date.now() - new Date(rec.lastFail).getTime() < FAIL_WINDOW;
}

function ChannelCard({ ch, failed, active, nowOn, onSelect }) {
  return (
    <button className={`chCard${active ? " on" : ""}${failed ? " dead" : ""}`} onClick={onSelect} title={ch.name}>
      <div className="chLogo">
        {ch.logo ? (
          <img src={ch.logo} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <span>📺</span>
        )}
      </div>
      <div className="chName">{ch.name}</div>
      {nowOn && <div className="chNow">▸ {nowOn}</div>}
      {ch.group && !nowOn && <div className="chGroup">{ch.group}</div>}
      {failed && <div className="chFail">✕ offline</div>}
    </button>
  );
}

export default function TvPage() {
  const [data, setData] = useState(null);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState(null);
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [providerMsg, setProviderMsg] = useState(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [playing, setPlaying] = useState(null);
  const [status, setStatus] = useState("");
  const [autoSkip, setAutoSkip] = useState(true);
  const [antiLag, setAntiLag] = useState(true);
  const [antiFreeze, setAntiFreeze] = useState(true);
  const [epgBusy, setEpgBusy] = useState(false);
  const [epgMsg, setEpgMsg] = useState(null);
  const [progress, setProgress] = useState(null);   // {now, next} for playing channel
  const [nowTitles, setNowTitles] = useState({});   // url → "what's on now"
  const [guideTick, setGuideTick] = useState(0);     // bumped when the guide reloads
  const [remember, setRemember] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);   // phone drawer
  const skipsRef = useRef(0);
  const shownRef = useRef([]);
  const playingRef = useRef(null);
  const watchdogRef = useRef(null);
  const videoRef = useRef(null);
  const statusRef = useRef(null);

  async function load() {
    const res = await fetch("/api/tv");
    setData(await res.json());
  }
  useEffect(() => { load(); }, []);

  // Restore remembered IPTV login (kept only in this browser's localStorage)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("hs_iptv_login") || "null");
      if (saved) {
        setHost(saved.host || "");
        setUsername(saved.username || "");
        setPassword(saved.password || "");
      }
    } catch {}
  }, []);

  const meta = data?.meta || {};

  const groups = useMemo(() => {
    if (!data) return [];
    const set = new Set();
    data.channels.forEach((c) => c.group && set.add(c.group));
    return ["All", ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [data]);

  // Channels matching the filter; recently-failed ones sink to the bottom.
  const shown = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const ok = [];
    const bad = [];
    for (const c of data.channels) {
      if ((group !== "All" && c.group !== group) || (q && !c.name.toLowerCase().includes(q))) continue;
      (isRecentlyFailed(meta, c.url) ? bad : ok).push(c);
    }
    return [...ok, ...bad];
  }, [data, query, group]);

  // Refs so the player's error handler can see the latest list/channel
  // without re-creating the player.
  useEffect(() => {
    shownRef.current = shown;
    playingRef.current = playing;
  }, [shown, playing]);

  useEffect(() => { statusRef.current = status; }, [status]);

  const knownChannels = useMemo(() => new Set(data?.channels.map((c) => c.url) || []), [data]);

  function recordFail(url) {
    const res = fetch("/api/tv/fail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    // Update UI immediately, no reload needed
    setData((d) => ({
      ...d,
      meta: { ...d.meta, [url]: { lastFail: new Date().toISOString(), failCount: (d.meta[url]?.failCount || 0) + 1 } },
    }));
    return res;
  }

  function skipToNext(reason) {
    const list = shownRef.current.filter((c) => c !== playingRef.current);
    if (list.length === 0) return;
    if (skipsRef.current >= MAX_AUTO_SKIPS) {
      setStatus(`${reason} — stopped after ${MAX_AUTO_SKIPS} skipped channels. Try selecting one manually.`);
      return;
    }
    skipsRef.current += 1;
    const next = list[0]; // first non-failed available (list order already skips-dead-last… keep quick: use first from list)
    setStatus(`${reason} → trying “${next.name}”…`);
    setTimeout(() => setPlaying(next), 700);
  }

  // (Re)build the player whenever the selected channel changes, then walk
  // the channel's candidate list until one attempt actually works.
  useEffect(() => {
    if (!playing || !videoRef.current) return;
    const el = videoRef.current;
    const candidates = buildCandidates(playing);
    let candidateIdx = 0;
    let hls = null;
    let settled = false;

    setStatus(candidates[0].label || "Connecting…");

    function cleanupAttempt() {
      if (hls) { hls.destroy(); hls = null; }
      el.playbackRate = 1; // a live catch-up rate must never leak into the next channel
      el.onerror = null;
      el.removeAttribute("src");
      el.load?.();
    }

    function allFailed() {
      cleanupAttempt();
      recordFail(playing.url);
      if (autoSkip) skipToNext("All formats failed");
      else setStatus("This channel failed in every format — try another.");
    }

    function tryCandidate() {
      if (candidateIdx >= candidates.length) { allFailed(); return; }
      const cand = candidates[candidateIdx];
      const url = cand.engine === "hls"
        ? `/api/tv/play?u=${encodeURIComponent(cand.url)}` // remote playlist → relay through CORS proxy
        : cand.url;                                        // restream & native urls are already same-origin
      setStatus(cand.label || "Connecting…");

      const watchdog = setTimeout(() => {
        // Attempt never produced playable data — move to the next format.
        if (settled || el.readyState >= 3) return;
        cleanupAttempt();
        candidateIdx += 1;
        tryCandidate();
      }, 15000);

      const advance = () => {
        clearTimeout(watchdog);
        cleanupAttempt();
        candidateIdx += 1;
        tryCandidate();
      };
      watchdogRef.current = watchdog;

      // On iPhone/iPad prefer native HLS (AirPlay requires native playback;
      // hls.js/MSE media can't be cast). The native branch below also handles
      // mp4 and transcode output, so it covers every engine on Apple devices.
      const nativeHls = el.canPlayType("application/vnd.apple.mpegurl");
      if ((cand.engine === "hls" || cand.engine === "restream") && !nativeHls && Hls.isSupported()) {
        const hlsCfg = {
          manifestLoadingTimeOut: 12000,
          fragLoadingTimeOut: 30000,
          capLevelToPlayerSize: true,
          ...(antiLag
            ? {
                // Anti-lag: tiny buffer, hug the live edge, drop resync grind
                lowLatencyMode: true,
                liveSyncDurationCount: 2,
                liveMaxLatencyDurationCount: 8,
                maxBufferLength: 8,
                maxMaxBufferLength: 24,
              }
            : {}),
        };
        hls = new Hls(hlsCfg);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          settled = true;
          clearTimeout(watchdog);
          if (cand.label) setStatus("");
          el.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          // Anti-freeze: reconnect/recover a few times before falling through
          if (antiFreeze && d.type === Hls.ErrorTypes.NETWORK_ERROR && repairs < 4) {
            repairs += 1;
            setStatus("🧊 Connection lost — reconnecting…");
            try { hls.startLoad(); } catch {}
            return;
          }
          if (antiFreeze && d.type === Hls.ErrorTypes.MEDIA_ERROR && repairs < 4) {
            repairs += 1;
            setStatus("🧊 Stream hiccup — repairing…");
            try { hls.recoverMediaError(); } catch { advance(); }
            return;
          }
          advance();
        });
        hls.loadSource(url);
        hls.attachMedia(el);
      } else {
        // native <video> (mp4 family, transcode output, Safari native HLS —
        // this is the branch iPhones take for both hls + restream formats)
        let nativeReconnects = 0;
        el.onerror = () => {
          if (settled) return; // stream dropped mid-watch — let the player UI show it
          advance();
        };
        // A live stream that reaches its end (provider cut the pipe, or a
        // playlist with #EXT-X-ENDLIST) auto-pauses. First try looping in
        // place (rewind/loop channels land here), then a true reconnect.
        el.onended = () => {
          if (!antiFreeze || nativeReconnects >= 3) return;
          nativeReconnects += 1;
          if (nativeReconnects <= 3) {
            try { el.currentTime = 0; el.play().catch(() => {}); return; } catch {}
          }
          setStatus("🧊 Stream ended — reconnecting at live edge…");
          try { el.load(); el.play().catch(() => {}); } catch {}
        };
        el.onplaying = () => {
          settled = true;
          clearTimeout(watchdog);
          nativeReconnects = 0;
          if (cand.label) setStatus("");
        };
        el.src = url;
        el.play().catch(() => {});
      }
    }

    // Anti-lag resync — smooth catch-up. A hard jump to the live edge reads
    // as stutter/skipping, so instead we briefly raise the playback rate
    // (up to +30%) until we're within ~1.5s of live again. Only a huge
    // drift (>60s: long pause / backgrounded tab) justifies an actual jump.
    const resync = setInterval(() => {
      const el2 = videoRef.current;
      if (!el2 || el2.paused) return;
      const buf = el2.buffered;
      const end = buf.length ? buf.end(buf.length - 1) : el2.currentTime;
      const drift = end - el2.currentTime;
      if (drift > 60) {
        try { el2.playbackRate = 1; el2.currentTime = end - 1; } catch {}
        return;
      }
      if (drift > 6) {
        el2.playbackRate = Math.min(1.3, 1 + (drift - 1.5) / 30);
        if (!statusRef.current?.startsWith("⚡")) {
          setStatus("⚡ Slightly behind live — catching up seamlessly");
          setTimeout(() => { if (!statusRef.current?.startsWith("⚡")) return; const v2 = videoRef.current; if (v2 && !v2.paused && Math.abs(v2.playbackRate - 1) < 0.01) setStatus(""); }, 2500);
        }
      } else if (el2.playbackRate !== 1) {
        el2.playbackRate = 1;
        if (statusRef.current?.startsWith("⚡")) setStatus("");
      }
    }, 4000);

    let lastTime = 0;      // anti-freeze: last observed playhead
    let stallTicks = 0;    // consecutive samples with no movement
    let repairs = 0;       // repair attempts in current attempt

    // Anti-freeze watchdog: sample the playhead every 4s. If it hasn't
    // moved while NOT paused, repair the stream (reconnect / recover);
    // after repeated failures move on to the next playback format.
    const freezeWatch = setInterval(() => {
      const el2 = videoRef.current;
      // NB: treat "ended" as a stalled stream too — live playlists that hit
      // their end (or a provider that cut the pipe) auto-pause the <video>,
      // and without this check a paused-but-dead stream never got repaired.
      if (!el2 || (el2.paused && !el2.ended) || !el2.currentTime || el2.currentTime <= 1) { lastTime = el2 ? el2.currentTime : 0; return; }
      if (Math.abs(el2.currentTime - lastTime) < 0.1) {
        stallTicks += 1;
        console.log("[anti-freeze] stalled", stallTicks);
        if (stallTicks >= 3) {
          // 3 samples (~12s frozen) — this format is beyond repair
          clearTimeout(watchdogRef.current);
          cleanupAttempt();
          candidateIdx += 1;
          tryCandidate();
          return;
        }
        if (!antiFreeze) return;
        setStatus("🧊 Frozen — repairing stream…");
        repairs += 1;
        if (hls) {
          try { hls.recoverMediaError(); } catch {}
          try { hls.startLoad(); } catch {}
        } else {
          // native stream: force a fresh connection (reconnects at live edge)
          try {
            el2.load();
            el2.play().catch(() => {});
          } catch {}
        }
      } else {
        stallTicks = 0;
        if (statusRef.current?.startsWith("🧊")) setStatus("");
      }
      lastTime = el2.currentTime;
    }, 4000);

    tryCandidate();
    return () => {
      cleanupAttempt();
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      clearInterval(resync);
      clearInterval(freezeWatch);
    };
  }, [playing, autoSkip, antiLag, antiFreeze]);

  function selectChannel(c) {
    skipsRef.current = 0;
    setPlaying(c);
  }

  async function loginProvider(e) {
    e.preventDefault();
    setLoggingIn(true);
    setProviderMsg({ kind: "info", text: `Connecting to ${host.trim()}…` });
    const res = await fetch("/api/tv/xtream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, username, password }),
    });
    const out = await res.json();
    setLoggingIn(false);
    if (!res.ok) {
      setProviderMsg({ kind: "err", text: out.error || "Login failed" });
      return;
    }
    setProviderMsg({ kind: "ok", text: `Connected! Imported ${out.added} channels from ${out.source?.display || "provider"}.` });
    setPassword("");
    if (remember) {
      try { localStorage.setItem("hs_iptv_login", JSON.stringify({ host: host.trim(), username: username.trim(), password })); } catch {}
    } else {
      try { localStorage.removeItem("hs_iptv_login"); } catch {}
    }
    load();
  }

  function fmtClock(ms) {
    const d = new Date(ms);
    return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  }

  // Guide extract for the channel being watched
  useEffect(() => {
    if (!playing) { setProgress(null); return; }
    let stale = false;
    (async () => {
      const res = await fetch(`/api/tv/epg?u=${encodeURIComponent(playing.url)}`);
      const out = await res.json();
      if (!stale) setProgress(res.ok ? out : { reason: out.error });
    })();
    return () => { stale = true; };
  }, [playing]);

  // "What's on" badges for the visible cards
  useEffect(() => {
    const slice = shown.slice(0, 100).map((c) => c.url);
    if (slice.length === 0) return;
    let stale = false;
    (async () => {
      const res = await fetch("/api/tv/epg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: slice }),
      });
      const out = await res.json();
      if (!stale && res.ok) setNowTitles(out);
    })();
    return () => { stale = true; };
  }, [shown, guideTick]);

  async function updateGuide(sourceKey) {
    setEpgBusy(true);
    setEpgMsg({ kind: "info", text: "Downloading the TV guide — big providers can take a minute…" });
    const res = await fetch("/api/tv/epg", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sourceKey ? { sourceKey } : {}),
    });
    const out = await res.json();
    setEpgBusy(false);
    if (!res.ok) { setEpgMsg({ kind: "err", text: out.error }); return; }
    setEpgMsg({ kind: "ok", text: `Guide loaded: ${out.programmes} programmes for ${out.channels} channels over the next 24h.` });
    setNowTitles({});
    setGuideTick((t) => t + 1);
  }

  async function importPlaylist(e) {
    e?.preventDefault();
    if (!source.trim()) return;
    setImporting(true);
    setMessage({ kind: "info", text: "Downloading and parsing playlist…" });
    const res = await fetch("/api/tv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const out = await res.json();
    setImporting(false);
    if (!res.ok) { setMessage({ kind: "err", text: out.error }); return; }
    setMessage({ kind: "ok", text: `Imported ${out.added} channels — ${out.total} total.` });
    setSource("");
    load();
  }

  async function clearAll() {
    if (!confirm("Remove all IPTV playlists and channels?")) return;
    await fetch("/api/tv", { method: "DELETE" });
    setPlaying(null);
    setGroup("All");
    load();
  }

  if (!data) return <div className="main" style={{ padding: 40, color: "var(--muted)" }}>Loading…</div>;

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
        <label className="notice" style={{ margin: "16px 0 0", cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={antiFreeze} onChange={(e) => setAntiFreeze(e.target.checked)} style={{ marginRight: 6 }} />
          🧊 Anti-freeze recovery
        </label>
        <label className="notice" style={{ margin: "16px 0 0", cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={antiLag} onChange={(e) => setAntiLag(e.target.checked)} style={{ marginRight: 6 }} />
          ⚡ Anti-lag (low latency)
        </label>
        <label className="notice" style={{ margin: "16px 0 0", cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={autoSkip} onChange={(e) => setAutoSkip(e.target.checked)} />
          Auto-skip dead channels
        </label>
        {data.sources.some((s) => s.epg) && (
          <button className="btn" style={{ marginTop: 12, width: "100%" }} disabled={epgBusy} onClick={() => updateGuide()}>
            {epgBusy ? "Loading guide…" : "📅 Update TV guide"}
          </button>
        )}
        {epgMsg && (
          <div className="notice" style={epgMsg.kind === "err" ? { color: "#ff8f8f", borderColor: "#46242a" } : undefined}>
            {epgMsg.text}
          </div>
        )}
        {data.sources.length > 0 && (
          <div className="panel" style={{ marginTop: 20, padding: 12 }}>
            <h3 style={{ fontSize: 13 }}>Playlists</h3>
            {data.sources.map((s) => (
              <div key={s.key} className="tag" style={{ margin: "6px 0 0", display: "block" }}>
                {s.kind === "xtream" ? "🔑 " : s.isUrl ? "🌐 " : "📄 "}{s.display || beautyUrl(s.source)} · {s.count}
              </div>
            ))}
            <button className="btn ghost" style={{ marginTop: 12, width: "100%", fontSize: 12, padding: 8 }} onClick={clearAll}>
              Clear all
            </button>
          </div>
        )}
      </aside>

      <main className="main">
        <div className="head">
          <button className="menuBtn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>☰</button>
          <h1>Live TV</h1>
          <input className="search" placeholder={`Search ${data.channels.length} channels…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          {groups.length > 2 && (
            <select className="input" style={{ width: 200 }} value={group} onChange={(e) => setGroup(e.target.value)}>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          )}
        </div>

        <section className="panel">
          <h3>Provider login (Xtream Codes)</h3>
          <p>
            The easier way: enter the server address, username and password from your IPTV subscription —
            the same three fields as in TiviMate/IPTV Smarters. Channels, logos and categories import automatically.
          </p>
          <label className="notice" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={remember} onChange={(e) => {
            setRemember(e.target.checked);
            if (!e.target.checked) {
              try { localStorage.removeItem("hs_iptv_login"); } catch {}
            } else if (host.trim() && username.trim() && password) {
              try { localStorage.setItem("hs_iptv_login", JSON.stringify({ host: host.trim(), username: username.trim(), password })); } catch {}
            }
          }} />
          🔑 Remember me (keeps my IPTV login on this device)
        </label>
        <form onSubmit={loginProvider}>
            <div className="credRow">
              <input className="input" placeholder="http://myprovider.tv:8080" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} autoComplete="off" />
              <input className="input" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              <input className="input" type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              <button className="btn" type="submit" disabled={loggingIn || !host.trim() || !username.trim() || !password}>
                {loggingIn ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
          {providerMsg && (
            <div className="notice" style={providerMsg.kind === "err" ? { color: "#ff8f8f", borderColor: "#46242a" } : undefined}>
              {providerMsg.text}
            </div>
          )}
        </section>

        <section className="panel">
          <h3>Add an IPTV playlist</h3>
          <p>Any M3U/M3U8 URL or local .m3u file path. Channels stream through your PC server, so CORS and mixed-content problems don't apply.</p>
          <form className="row" onSubmit={importPlaylist}>
            <input className="input" placeholder="https://example.com/playlist.m3u  or  C:\TV\mylist.m3u" value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} />
            <button className="btn" type="submit" disabled={importing || !source.trim()}>{importing ? "Importing…" : "Import"}</button>
          </form>
          {message && (
            <div className="notice" style={message.kind === "err" ? { color: "#ff8f8f", borderColor: "#46242a" } : undefined}>
              {message.text}
            </div>
          )}
        </section>

        {playing && (
          <>
            <div className="playerBox" style={{ position: "relative" }}>
              <video x-webkit-airplay="allow" disableRemotePlayback="false" ref={videoRef} controls autoPlay playsInline />
              <PipButton videoRef={videoRef} style={{ position: "absolute", top: 10, right: 10, zIndex: 5 }} />
            </div>
            <h1 className="wtitle">
              {playing.logo && <img src={playing.logo} alt="" style={{ height: 22, marginRight: 8, verticalAlign: "-4px" }} onError={(e) => (e.currentTarget.style.display = "none")} />}
              {playing.name}
            </h1>
            <div className="wsub">
              {progress?.now
                ? <>Now: <b>{progress.now.t}</b>{progress.now.s ? ` (${fmtClock(progress.now.s)}–${fmtClock(progress.now.e)})` : ""}{progress.now.g ? ` · ${progress.now.g}` : ""}</>
                : (status || playing.group || "Live channel")}
            </div>
            {progress?.reason && !status && (
              <div className="notice" style={{ maxWidth: 720, marginTop: 10 }}>
                📅 {progress.reason} — your provider publishes schedules for some channels only; "Update TV guide" refreshes them.
              </div>
            )}
            {progress?.now?.i && !status && (
              <div className="notice" style={{ maxWidth: 720, marginTop: 10 }}>{progress.now.i}</div>
            )}
            {progress?.next?.length > 0 && !status && (
              <div className="notice" style={{ maxWidth: 720, marginTop: 8 }}>
                <span style={{ color: "var(--text)", fontWeight: 600 }}>Up next:</span>
                {progress.next.slice(0, 4).map((n) => ` ${fmtClock(n.s)} ${n.t}`).join(" · ")}
              </div>
            )}
          </>
        )}

        <section className="hrow">
          <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>
            Channels{shown.length !== data.channels.length ? ` (${shown.length} of ${data.channels.length})` : ""}
          </h2>
          {shown.length === 0 ? (
            <div className="empty" style={{ maxWidth: 560, margin: "12px auto 0" }}>
              {knownChannels.size === 0 ? "No channels yet — import a playlist above." : "Nothing matches this filter."}
            </div>
          ) : (
            <div className="chGrid">
              {shown.slice(0, 500).map((c) => (
                <ChannelCard
                  key={c.url}
                  ch={c}
                  failed={isRecentlyFailed(meta, c.url)}
                  active={playing === c}
                  nowOn={nowTitles[c.url]}
                  onSelect={() => selectChannel(c)}
                />
              ))}
            </div>
          )}
          {shown.length > 500 && (
            <div className="notice" style={{ marginTop: 12 }}>Showing first 500 — use search or categories to narrow down.</div>
          )}
        </section>
      </main>
    </div>
  );
}
