"use client";

import { useEffect } from "react";

/**
 * Tracks playback position for a <video> (pass its ref) and syncs it to the
 * server. On mount it resumes where the user left off (same behavior on
 * every device, since the position lives in .data/progress.json).
 * Auto-clears once you watch past ~96%.
 */
export function useWatchProgress(videoRef, url, meta = {}) {
  useEffect(() => {
    const el = videoRef.current;
    if (!url || !el) return;

    let dirty = false;
    let done = false;

    const save = (keepalive = false) => {
      if (done || !dirty) return;
      const pos = el.currentTime;
      const dur = el.duration;
      if (!isFinite(pos) || !isFinite(dur) || dur < 60) return;
      if (pos / dur > 0.96) {
        done = true;
        fetch("/api/progress", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: url }),
          keepalive,
        }).catch(() => {});
        return;
      }
      fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: url, position: pos, duration: dur, ...meta }),
        keepalive,
      }).catch(() => {});
    };

    const onMetadata = async () => {
      try {
        const res = await fetch(`/api/progress?id=${encodeURIComponent(url)}`);
        const out = await res.json();
        const item = out?.item;
        // resume only if meaningfully into the video and not basically finished
        if (item && item.position > 15 && item.duration > 60 && item.position / item.duration < 0.95) {
          try { el.currentTime = item.position; } catch {}
        }
      } catch {}
    };
    el.addEventListener("loadedmetadata", onMetadata);

    const iv = setInterval(() => {
      dirty = el.readyState >= 2 && !el.paused;
      save();
    }, 10000);

    return () => {
      el.removeEventListener("loadedmetadata", onMetadata);
      clearInterval(iv);
      save(true); // best-effort final save when leaving the player
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
}

/** Hook that supplies the Continue Watching list to rows. */
export function useContinueList(headerKey = "x") {
  return headerKey;
}
