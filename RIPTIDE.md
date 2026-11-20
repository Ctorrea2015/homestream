# Riptide — HomeStream's custom streaming engine

Riptide is a torrent engine that speaks **rqbit's exact HTTP API**, so HomeStream works unchanged (`lib/rqbit.js` verified against it end-to-end). Point HomeStream at it:

```json
// .data/rqbit.json
{ "host": "http://127.0.0.1:3031" }
```

Run it:

```bash
cd ~/homestream/custom-engine
node riptide.mjs
```

Make Riptide engine #1 by enabling it:

```json
// .data/riptide.json
{ "enabled": true, "host": "http://127.0.0.1:3031" }
```

With that file, both the stream route and ⚡ Auto resolver try **Riptide first**, then fall back to the stock rqbit daemon, then qB, then webtorrent. Remove the file (or set `enabled: false`) to go back to rqbit-first.

Config: `custom-engine/riptide-config.json`

## Why it's better than rqbit here

| # | Feature | What it does |
|---|---|---|
| 2 | **Real seeder gate** | UDP-scrapes trackers before adding; dead swarms (0 seeders) are rejected with HTTP 409, so HomeStream moves to its next ranked source instead of stalling at 0 bytes |
| 3 | **15 s failover** | If a registered torrent has 0 peers and 0 bytes after 15 s, Riptide deletes it and switches to the alternate infoHash (`?alt=` on add) |
| 4 | **Stream-first focus** | Remembers the file HomeStream will play (`update_only_files`) and keeps that file's pieces hot; qB backend sets real file priorities |
| 5 | **Bounded state + rolling cleanup** | Liveness maps capped at 500 entries; torrents idle for 30 min are deleted automatically |

Watchdog compatibility: empty-body `POST /torrents` answers HTTP 400 instantly (Riptide never wedges like rqbit did).

## rqbit API surface implemented

| Endpoint | Response shape |
|---|---|
| `GET /torrents` | `{ torrents: [{ id, info_hash, name, total_pieces }] }` |
| `POST /torrents?overwrite=true` | Magnet (text/plain) or `.torrent` bytes → `{ id, details: { id, info_hash } }`; empty body → 400 instantly |
| `GET /torrents/{id}` | `{ files: [{ name, length }], output_folder }` |
| `GET /torrents/{id}/stats` | `{ snapshot: { fetched_bytes, downloaded_and_checked_bytes, peer_stats: { live, live_seeders } }, download_speed: { human_readable } }` |
| `POST /torrents/{id}/update_only_files` | JSON `{ only_files: [idx] }` → 200 |
| `GET /torrents/{id}/stream/{fileIdx}` | 206 + `Content-Length`, `Content-Range`, video content-type |
| `POST /torrents/{id}/delete` / `/{infoHash}/delete` | 200 |
| `POST /torrents/{id}/pause` | 200 |
| `GET /` | `{ ok, engine: "Riptide", backend, features }` |

## Backends

- **mock** — serves a local file with simulated stats; zero setup for development.
- **qb** — proxies to qBittorrent WebUI (real downloads today). Replace `BE` with your own peer/piece engine later; HomeStream never changes.

## Verified

```
add → 200 | stats → 200 | only_files → 200 | stream Range → 206
HomeStream rqEnsureTorrent → Riptide stream URL ✅
seeder gate (0 seeders) → 409 "dead_swarm" ✅
watchdog canary (empty POST) → 400 ✅
```
