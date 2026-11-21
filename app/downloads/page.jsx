"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return "—";
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  return (bytes / 1e6).toFixed(0) + " MB";
}

const ENGINE_COLOR = { Riptide: "#7df9ff", rqbit: "#c9a7ff", qB: "#ffd479" };

export default function DownloadsPage() {
  const [data, setData] = useState({ downloads: [], at: null });
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await fetch("/api/downloads", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError("");
    } catch (e) { setError(String(e.message || e)); }
  };

  const remove = async (d) => {
    if (!confirm(`Delete "${d.name}" from ${d.engine} (including files)?`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/downloads/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: d.engine, id: d.id, hash: d.fullHash }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.ok) throw new Error(out.error || `HTTP ${r.status}`);
      await load();
    } catch (e) { setError(`Delete failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  const clearIdle = async () => {
    const idle = (data.downloads || []).filter((d) => Number(d.peers) === 0 && !/downloading/i.test(d.status || "") || Number(d.peers) === 0 && /wait|idle|stall/i.test(d.status || ""));
    if (!idle.length) return alert("No idle torrents (0 peers) to clear.");
    if (!confirm(`Delete ${idle.length} idle torrent(s) with 0 peers?`)) return;
    setBusy(true);
    for (const d of idle) {
      try {
        await fetch("/api/downloads/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ engine: d.engine, id: d.id, hash: d.fullHash }),
        });
      } catch {}
    }
    setBusy(false);
    await load();
  };

  useEffect(() => {
    let live = true;
    const first = () => { load().then(() => { if (live) {} }); };
    first();
    const t = setInterval(() => { if (!paused) load(); }, 5000);
    return () => { live = false; clearInterval(t); };
  }, [paused]);

  const rows = data.downloads || [];
  return (
    <main className="wrap">
      <header className="bar">
        <div>
          <h1>Downloads</h1>
          <p className="sub">What the engines are pulling right now — updates every 5 s</p>
        </div>
        <div className="bar-actions">
          <Link href="/">← Home</Link>
          <button onClick={clearIdle} disabled={busy}>🧹 Clear idle</button>
          <button onClick={() => setPaused((p) => !p)}>{paused ? "▶ Resume" : "⏸ Pause"}</button>
        </div>
      </header>

      {error && <div className="error">Could not reach the server: {error}</div>}

      {rows.length === 0 && !error ? (
        <div className="empty">
          <div className="empty-glyph">⬇</div>
          <h2>Nothing downloading</h2>
          <p>Play something in Debrify and it will show up here within a few seconds.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Engine</th><th>Title</th><th>Progress</th><th>Speed</th><th>Peers</th><th>Size</th><th>ETA</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((d, i) => (
                <tr key={`${d.engine}-${d.infoHash}-${i}`}>
                  <td><span className="engine" style={{ color: ENGINE_COLOR[d.engine] || "#fff" }}>{d.engine}</span></td>
                  <td className="name" title={d.name}>{d.name}</td>
                  <td>
                    {d.progress == null ? <span className="muted">—</span> : (
                      <div className="progress"><div className="fill" style={{ width: `${d.progress}%` }} /><span>{d.progress}%</span></div>
                    )}
                  </td>
                  <td className="speed">{d.speed}</td>
                  <td className="peers" title={`${d.seeders} seeders`}>{d.peers} <span className="muted">({d.seeders} 🌱)</span></td>
                  <td>{fmtSize(d.size)}</td>
                  <td>{d.eta || <span className="muted">—</span>}</td>
                  <td><span className={`status ${/dead|fail|stall|wait/i.test(d.status) ? "warn" : ""}`}>{d.status}</span></td>
                  <td><button className="del" onClick={() => remove(d)} disabled={busy} title="Delete torrent + files">✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="foot">
        <span>{data.at ? `Updated ${new Date(data.at).toLocaleTimeString()}` : "Connecting…"}</span>
        <Link href="/api/downloads">Raw JSON ↗</Link>
      </footer>
    </main>
  );
}
