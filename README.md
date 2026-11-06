# 🎬 HomeStream

A self-hosted media server for your home: your **own PC runs the server**, every device in the house (and anywhere via Tailscale) streams with just a browser.

## Features

- **🎬 Library** — Jellyfin-style watch folders, TMDB posters, TV show grouping (S01E01 detection), auto-rescan every 10 min
- **📺 Live TV** — IPTV provider (Xtream Codes) + any M3U playlist, 20k+ channels, anti-freeze/anti-lag recovery, auto-skip dead channels
- **🗓️ TV Guide** — full EPG grid (Now / Next), press the screen to zoom in
- **🍿 Movies & TV** — provider VOD catalog with posters
- **🧩 Addons** — paste any Stremio addon manifest: catalogs + stream sources
- ** torrents Torrent streaming** — built-in server-side BitTorrent engine (WebTorrent): movies play with no debrid service, exactly like Stremio does on the phone; auto-converts HEVC/mkv to browser-friendly H.264 via ffmpeg when needed
- **▶ Continue Watching** — server-synced resume positions for every device
- **🔍 Search** everywhere, **<tool_call> picture-in-picture** on every player, **installed as an app** (PWA) on phones/tablets
- **📡 Remote access** — same Wi-Fi (LAN IP + QR setup) or Tailscale from anywhere

## Requirements

- Node.js 20+
- ffmpeg (for anything the browser can't natively play)

## Run it

```bash
npm install
npm run build
npm run start
# → http://localhost:3000
```

## Important

- All app data (IPTV login, library, progress, addon list, guide cache) lives in `.data/` next to the app — that folder is **private** and git-ignored. Back it up when migrating servers.
- Live TV / movies come from your own IPTV provider.

## Source

Built with Next.js 15 (App Router), hls.js, WebTorrent, ffmpeg. This app is self-hosted; you are responsible for complying with the law regarding what streams or files you add.
