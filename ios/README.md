# HomeStream Player for iPhone (native, SwiftUI + VLCKit)

A native iPhone app that plays your HomeStream torrent streams **directly** — native
MKV / HEVC / 10-bit / DDP decode, so the Pi never has to transcode. That's the whole
reason for a native app over the browser player.

## Why (vs Debrify / browser)

- Browser on iPhone can't play MKV → HomeStream transcodes on the Pi → 10-bit/x265 sources stall or quit.
- This app uses **MobileVLCKit** to decode locally. Any source the server streams plays.
- Uses HomeStream's `⚡ Auto` resolver, so it plays the warmed source (fast start).

## What it does

- **Movies / Shows** tabs — browse your HomeStream library catalog
- **Search** — IMDb search via Cinemeta, opens through HomeStream
- **Detail** — poster + ⚡ Play (resolves the best source, auto-loads into Riptide)
- **Player** — VLC native playback, tap for controls, resume position saved per title/episode
- **Settings** — server URL (LAN or Tailscale), connection test

## Build (on a Mac)

1. Install Xcode, Homebrew, XcodeGen, CocoaPods:
   ```bash
   brew install xcodegen cocoapods
   ```
2. Generate the project and install VLCKit:
   ```bash
   cd ios
   xcodegen generate
   pod install
   ```
3. Open `HomeStreamPlayer.xcworkspace` in Xcode.
4. **Signing**: select your Apple ID/team under Signing (free Apple ID works for sideload; set `DEVELOPMENT_TEAM` in `project.yml` or in Xcode).
5. Set the server URL in Settings after first launch (Tailscale `http://100.93.204.117:3000` or LAN `http://192.168.68.56:3000`).
6. Build & run on your iPhone (or sideload with Sideloadly/AltStore).

## Notes

- `NSAllowsArbitraryLoads` is on so plain HTTP (LAN/Tailscale) works.
- Resume position is stored in `UserDefaults` keyed by title + season/episode.
- The app never downloads to the phone — bytes stream from HomeStream to VLC directly.

## Files

| File | Purpose |
|---|---|
| `HomeStreamPlayerApp.swift` | App entry |
| `Settings.swift` | Server URL (persisted) |
| `API.swift` | HomeStream addon client (catalog, meta, resolve, streams) |
| `VLCPlayerView.swift` | UIViewRepresentable wrapping VLCMediaPlayer |
| `PlayerView.swift` | Player UI + resume |
| `BrowseView.swift` | Movies / Shows / Search |
| `DetailView.swift` | Title detail + play |
| `SettingsView.swift` | Settings UI + connection test |
| `project.yml` | XcodeGen project definition |
| `Podfile` | MobileVLCKit dependency |
