"use client";

import { useEffect, useState } from "react";

/**
 * Picture-in-Picture button for any <video> element (pass its ref).
 * Uses the browser's native picture-in-picture APIs so the video floats
 * over other apps/windows while you switch tabs or use your phone.
 * The button hides itself on browsers/devices without PiP support.
 */
export default function PipButton({ videoRef, style }) {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        "pictureInPictureEnabled" in document &&
        document.pictureInPictureEnabled &&
        // iPhone Safari has no iframe/element PiP API but shows its own
        // native PiP button on the <video controls> UI — nothing to add.
        !/iPhone|iPod/.test(navigator.userAgent || "")
    );
  }, []);

  if (!supported) return null;

  async function toggle() {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement === el) {
        await document.exitPictureInPicture();
      } else {
        await el.requestPictureInPicture();
      }
    } catch (err) {
      console.error("PiP failed:", err);
    }
  }

  return (
    <button
      className="btn ghost"
      style={{ fontSize: 12, padding: "6px 10px", ...style }}
      onClick={toggle}
      title="Picture-in-Picture — watch in a floating window while you use other apps"
    >
      🗗 PiP
    </button>
  );
}
