# Building an engine better than rqbit — the practical path

rqbit is a mature Rust BitTorrent client. Rewriting the **protocol stack** (DHT, peer wire, bencode, piece selection) to beat it is a multi-week project with a high bar. But HomeStream doesn't need a better `libtorrent` — it needs a better **engine for streaming**. That's where rqbit actually fails here (wedges, 60 s metadata resolves, dead swarms, no failover).

## The compatible service already gives you

`custom-engine/rqbit-compatible.mjs` speaks rqbit's exact HTTP API, so HomeStream works unchanged (`lib/rqbit.js` verified against it end-to-end). Point HomeStream at it:

```json
// .data/rqbit.json
{ "host": "http://127.0.0.1:3031" }
```

Backends: `mock` (zero setup) or `qb` (real downloads via qBittorrent WebUI). Replace the backend with your own logic when ready — HomeStream never needs to change.

## rqbit API surface you must implement

| Endpoint | Used for | Required response shape |
|---|---|---|
| `GET /torrents` | list/search by infoHash | `{ torrents: [{ id, info_hash, name, total_pieces }] }` |
| `POST /torrents?overwrite=true` | add magnet (text/plain) or `.torrent` bytes | `{ id, details: { id, info_hash } }`; **empty body must return 400 instantly** (watchdog canary) |
| `GET /torrents/{id}` | file list + output folder | `{ files: [{ name, length }], output_folder }` |
| `GET /torrents/{id}/stats` | health/first-bytes/peer checks | `{ snapshot: { fetched_bytes, downloaded_and_checked_bytes, peer_stats: { live, live_seeders } }, download_speed: { human_readable } }` |
| `POST /torrents/{id}/update_only_files` | focus one episode (disk safety) | JSON `{ only_files: [idx] }` → 200 |
| `GET /torrents/{id}/stream/{fileIdx}` | **Range-capable video** | 206 with `Content-Length`, `Content-Range`, video content-type |
| `POST /torrents/{id}/delete` / `/{infoHash}/delete` | cleanup | 200 |
| `POST /torrents/{id}/pause` | janitor | 200 |

## Where to actually be better than rqbit

Pick one and I'll build it into the service while keeping the contract intact:

1. **Never wedge** — stay responsive on adds; no watchdog restarts needed (rqbit's #1 failure mode here).
2. **Real seeder verification before add** — query trackers/DHT and skip dead swarms; rqbit doesn't, which caused the 0-byte stalls.
3. **10–15 s auto-failover** — if peers stay 0 or speed stalls, drop the torrent and try source #2 automatically.
4. **Stream-first piece priority** — first + last MB and the picked file only; go beyond `update_only_files`.
5. **Bounded memory/disk** — cap per-torrent buffers, auto-delete idle.

Tell me which one, and I'll implement it in `rqbit-compatible.mjs` — you get a better engine without touching HomeStream.
