"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function fmtTime(s) {
  if (!s) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(sec).padStart(2, "0");
}

function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  return (bytes / 1e6).toFixed(0) + " MB";
}

export default function WatchPage() {
  const [video, setVideo] = useState(null);
  const [error, setError] = useState(null);
  const [speed, setSpeed] = useState(1);
  const videoRef = useRef(null);

  // Read ?id= directly — avoids needing Suspense around useSearchParams
  const id = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("id") : null;

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/library");
      const data = await res.json();
      const v = data.videos.find((x) => x.id === id);
      if (!v) {
        if (data.videos.length === 0) setError("Your library is empty — go back and scan a video folder first.");
        else setError("Video not found in your library.");
        return;
      }
      setVideo(v);
    })();
  }, [id]);

  // Resume where you left off (stored in localStorage)
  useEffect(() => {
    if (!video || !videoRef.current) return;
    try {
      const saved = JSON.parse(localStorage.getItem("hs_progress") || "{}")[video.id];
      if (saved && saved.pos > 15 && saved.dur && saved.pos < saved.dur * 0.97) {
        videoRef.current.currentTime = saved.pos;
      }
    } catch {}
  }, [video]);

  // Save progress as you watch
  useEffect(() => {
    const el = videoRef.current;
    if (!video || !el) return;
    const save = () => {
      try {
        const all = JSON.parse(localStorage.getItem("hs_progress") || "{}");
        all[video.id] = { pos: el.currentTime, dur: el.duration || 0, at: Date.now() };
        localStorage.setItem("hs_progress", JSON.stringify(all));
      } catch {}
    };
    const t = setInterval(save, 5000);
    el.addEventListener("pause", save);
    const onUnload = () => save();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      clearInterval(t);
      save();
      el.removeEventListener("pause", save);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [video]);

  function setRate(r) {
    setSpeed(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
  }

  async function deleteFromLibrary() {
    if (!video || !confirm(`Remove “${video.name}” from your library?\n\n(The file itself is NOT deleted.)`)) return;
    await fetch("/api/library", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeId: video.id }),
    });
    window.location.href = "/";
  }

  return (
    <div className="shell">
      <main className="main watch">
        <Link className="wback" href="/">← Back to library</Link>

        {error && (
          <div className="empty" style={{ marginTop: 20, maxWidth: 560 }}>{error}</div>
        )}

        {!error && !video && (
          <div style={{ color: "var(--muted)", padding: "40px 0" }}>Loading player…</div>
        )}

        {video && (
          <>
            <div className="playerBox">
              <video x-webkit-airplay="allow" disableRemotePlayback="false" ref={videoRef} controls autoPlay src={`/api/stream?id=${video.id}`} />
            </div>

            <h1 className="wtitle">{video.name}</h1>
            <div className="wsub">
              {video.root}{video.folder ? "\\" + video.folder : ""} · {fmtSize(video.size)} · {video.ext.toUpperCase()}
            </div>

            <div className="wactions">
              <div className="rate">
                <span style={{ color: "var(--muted)", fontSize: 13, marginRight: 4 }}>Speed</span>
                {SPEEDS.map((r) => (
                  <button key={r} className={r === speed ? "on" : ""} onClick={() => setRate(r)}>{r}×</button>
                ))}
              </div>
              <button
                className="btn ghost"
                onClick={() => {
                  const el = videoRef.current;
                  if (el.requestPictureInPicture) el.requestPictureInPicture().catch(() => {});
                }}
              >
                ⧉ Picture-in-picture
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  const el = videoRef.current;
                  if (document.fullscreenElement) document.exitFullscreen();
                  else el.parentElement.requestFullscreen().catch(() => {});
                }}
              >
                ⛶ Fullscreen
              </button>
              <button className="btn ghost" onClick={deleteFromLibrary} style={{ color: "#ff8f8f" }}>
                🗑 Remove from library
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
