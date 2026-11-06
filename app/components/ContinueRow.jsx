"use client";

import { useEffect, useState } from "react";

/**
 * "Continue Watching" horizontal row — plays any partially-watched title
 * right where you left off. Position/source lives on the server, so it
 * works across every device in the house.
 */
export default function ContinueRow({ onSelect, refreshKey = 0 }) {
  const [items, setItems] = useState(null);

  useEffect(() => {
    let stale = false;
    (async () => {
      const res = await fetch("/api/progress");
      const out = await res.json();
      if (!stale) setItems(res.ok ? out.items : []);
    })();
    return () => { stale = true; };
  }, [refreshKey]);

  if (!items || items.length === 0) return null;

  return (
    <section style={{ margin: "4px 0 8px" }}>
      <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>▶ Continue Watching</h2>
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6 }}>
        {items.map((x) => {
          const pct = Math.min(100, Math.round((x.position / (x.duration || 1)) * 100));
          const left = Math.max(1, Math.round(((x.duration || 0) - x.position) / 60));
          return (
            <button
              key={x.id}
              className="card"
              onClick={() => onSelect(x)}
              title={`${x.title} — continue at ${pct}%`}
              style={{ flex: "0 0 150px", textAlign: "left", position: "relative" }}
            >
              {x.poster ? (
                <img src={x.poster} alt="" loading="lazy" style={{ width: "100%", borderRadius: 8 }} onError={(e) => (e.currentTarget.style.opacity = 0.25)} />
              ) : (
                <div style={{ fontSize: 40, textAlign: "center" }}>🎬</div>
              )}
              <div style={{ fontWeight: 600, fontSize: 12, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.title || "Continue"}</div>
              <div style={{ color: "var(--muted)", fontSize: 11 }}>{left} min left · {pct}%</div>
              <div style={{ position: "relative", height: 4, background: "#2a3342", borderRadius: 2, marginTop: 4, overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: "var(--accent, #3b82f6)" }} />
              </div>
              <span
                role="button"
                aria-label="Remove from Continue Watching"
                onClick={(e) => {
                  e.stopPropagation();
                  fetch("/api/progress", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: x.id }),
                  }).then(() => setItems((cur) => cur.filter((y) => y.id !== x.id)));
                }}
                style={{ position: "absolute", top: 4, right: 8, background: "rgba(0,0,0,.6)", borderRadius: "50%", width: 22, height: 22, lineHeight: "22px", fontSize: 12, textAlign: "center" }}
              >✕</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
