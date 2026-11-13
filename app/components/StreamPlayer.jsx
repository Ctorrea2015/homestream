"use client";

import Hls from "hls.js";
import PipButton from "./PipButton";
import { useWatchProgress } from "./watchProgress";
import { useEffect, useRef, useState } from "react";

/** VLC/Infuse hand-off. In an installed standalone PWA, iOS blocks custom
 * scheme links — and navigator.clipboard is unavailable on plain HTTP.
 * So: show the link as selectable text (long-press → Copy) plus an
 * execCommand fallback that still works on http. */
export function ExternalButtons({ url }) {
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

/**
 * The movie-style player shared by the addons page and the Netflix-style
 * home page: candidate cycling across every source, duration probe +
 * tap-to-seek timeline, ephemeral-torrent cleanup, VLC/Infuse hand-off.
 */
export default function StreamPlayer({ url, sources, title, poster, back }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("Connecting…");
  const [duration, setDuration] = useState(null);
  const [seekBase, setSeekBase] = useState(0);
  const [session, setSession] = useState(0);
  const [tick, setTick] = useState(0);
  useWatchProgress(videoRef, url, { title, poster, type: "movie" });
  const proxy = (u) => `/api/tv/play?u=${encodeURIComponent(u)}`;

  // Ephemeral torrents: when playback closes (Back, tab close, app swipe),
  // tell the server to delete the torrent task + files via rqbit/qB. This
  // keeps streamed movies from piling up on the Pi's disk (Stremio-cache
  // behavior). sendBeacon survives page unload where fetch does not — but
  // iOS can drop beacons on in-app navigation, so the Back button ALSO
  // fires an explicit fetch. Two triggers, one endpoint, idempotent.
  const cleanupUrl = url?.startsWith("/") && url.includes("/api/torrent/stream")
    ? (() => {
        const ih = new URL(url, window.location.origin).searchParams.get("infoHash");
        return ih ? `/api/torrent/cleanup?infoHash=${ih}&engine=both` : null;
      })()
    : null;
  const fireCleanup = () => {
    if (!cleanupUrl) return;
    try { navigator.sendBeacon(cleanupUrl); } catch {}
    try { fetch(cleanupUrl, { method: "POST", keepalive: true }).catch(() => {}); } catch {}
  };
  useEffect(() => {
    if (!cleanupUrl) return;
    const cleanup = () => fireCleanup();
    window.addEventListener("pagehide", cleanup);
    return () => { window.removeEventListener("pagehide", cleanup); cleanup(); };
  }, [cleanupUrl]);

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
        <button className="btn ghost" onClick={() => { fireCleanup(); back(); }}>← Back</button>
      </div>
    </div>
  );
}
