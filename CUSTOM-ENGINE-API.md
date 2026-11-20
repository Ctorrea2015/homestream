# Custom Engine API Contract

HomeStream calls **your engine** with a title/id; you return ranked torrent candidates.
HomeStream then loads the top one into rqbit and hands the client a `/api/torrent/stream` URL. Everything downstream (ranker, janitor, watchdog, device codec handling) stays the same.

## 1. Request

`POST http://<your-engine>/streams`

```json
{
  "type": "movie",          // "movie" or "series"
  "id": "tt0120338",        // IMDb id; series may be "tt1234567:1:1"
  "title": "Titanic",       // optional but useful for text search
  "season": null,
  "episode": null
}
```

Optional header `X-API-Key: <key>` — set `apiKey` in HomeStream's config to send it.

## 2. Response

```json
{
  "provider": "my-engine",
  "streams": [
    {
      "infoHash": "40 hex characters (required)",
      "title": "Titanic 1997 1080p BluRay x264 👤 197 💾 4.1 GB",
      "seeders": 197,
      "size": 4400000000,
      "trackers": ["udp://tracker.opentrackr.org:1337/announce"]
    }
  ]
}
```

Only `infoHash` + `title` are required. `seeders`/`size` are folded into the title as 👤/💾 badges so HomeStream's ranker can score them; `trackers` are appended to the magnet rqbit receives.

An empty `streams` array simply means "no candidates" — HomeStream falls back to its own sources.

## 3. HomeStream config

`.data/custom-engine.json`:

```json
{
  "enabled": true,
  "url": "http://127.0.0.1:4000",
  "apiKey": "",
  "timeoutMs": 20000
}
```

Status: `GET /api/custom-engine/health` (shows config + connectivity).
Test query: `GET /api/custom-engine/health?id=tt0120338&type=movie`.

## 4. Where candidates flow

```
your engine → /api/torrent/stream candidates → ranker (resolution/codec/seeders)
→ pre-warm → rqbit (POST /torrents) → client gets absolute stream URL
```

Your engine can be written in any language — Node, Python, Go — as long as it speaks this JSON contract. The bundled reference implementation is `custom-engine/server.mjs`.

## 5. Reference engine features

- **Multi-source**: Torrentio (`torrentioUrl` in `custom-engine/config.json`) + apibay; add Jackett/Prowlarr by writing another `fromX()` fetcher and pushing into the `all` array.
- **Health gate**: releases with 0 seeders are dropped; real apibay counts outrank cached addon badges.
- **Ranking**: seeders + 1080p/x264/AAC/MKV preference for native iOS playback; 4K/REMUX/AV1/YIFY demoted.
- **Trackers**: a healthy public UDP/HTTP list is appended to every result.

Run it: `node custom-engine/server.mjs` (port 4000, override with `PORT`).
