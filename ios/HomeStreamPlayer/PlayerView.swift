import SwiftUI
import UIKit

struct PlayerView: View {
    let stream: API.Stream
    let title: String
    let resumeKey: String

    @State private var position: Float = 0
    @State private var time: TimeInterval = 0
    @State private var showControls = true
    @State private var playerID = 0
    @State private var zoom: CGFloat = 1.0
    @State private var lastZoom: CGFloat = 1.0
    @State private var showAirPlayInfo = false
    @EnvironmentObject var settings: Settings
    @Environment(\.dismiss) private var dismiss

    private let saved = UserDefaults.standard

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VLCPlayerView(url: stream.streamURL!,
                          startPosition: saved.float(forKey: resumeKey),
                          onProgress: { pos, t in position = pos; time = t },
                          onFinished: { saved.removeObject(forKey: resumeKey); dismiss() })
                .id(playerID)
                .scaleEffect(zoom)                       // pinch / double-tap zoom
                .ignoresSafeArea()
                .onTapGesture { withAnimation { showControls.toggle() } }
                .gesture(
                    TapGesture(count: 2).onEnded {
                        withAnimation { zoom = (zoom > 1.01) ? 1.0 : 1.8 } // double-tap: 1x <-> 1.8x
                    }
                )
                .simultaneousGesture(
                    MagnificationGesture()
                        .onChanged { v in zoom = min(3.0, max(1.0, lastZoom * v)) }
                        .onEnded { _ in lastZoom = zoom }
                )

            if showControls {
                VStack {
                    HStack {
                        Button { dismiss() } label: { Image(systemName: "chevron.left").font(.title2) }
                        Spacer()
                        Text(title).font(.headline).lineLimit(1)
                        Spacer()
                        // AirPlay — VLCKit can't route to AirPlay, so hand off
                        // to Safari's native HLS player (which has real AirPlay).
                        Button { showAirPlayInfo = true } label: {
                            Image(systemName: "airplayvideo").font(.title3)
                        }
                        // Fullscreen = hide all controls (tap to bring them back)
                        Button { withAnimation { showControls = false } } label: {
                            Image(systemName: "arrow.expand.rectangle").font(.title3)
                        }
                        Button { saved.removeObject(forKey: resumeKey); playerID += 1 } label: {
                            Image(systemName: "arrow.clockwise").font(.title3)
                        }
                    }
                    .padding().foregroundStyle(.white)
                    .background(LinearGradient(colors: [.black.opacity(0.8), .clear], startPoint: .top, endPoint: .bottom))
                    Spacer()
                    VStack(spacing: 6) {
                        Text(fmt(time)).font(.caption).monospacedDigit()
                        Slider(value: $position, in: 0...1)
                            .onChange(of: position) { v in saved.set(v, forKey: resumeKey) }
                        HStack {
                            Button { zoom = max(1.0, zoom - 0.2) } label: { Image(systemName: "minus.magnifyingglass") }
                            Button { zoom = 1.0; lastZoom = 1.0 } label: { Text("Fit") }
                            Button { zoom = min(3.0, zoom + 0.2) } label: { Image(systemName: "plus.magnifyingglass") }
                            Spacer()
                            Text("Pinch / double-tap to zoom").font(.caption2).foregroundStyle(.secondary)
                        }
                        .font(.title3)
                    }
                    .padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    .padding()
                }
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showAirPlayInfo) { airPlaySheet }
        // Auto-hide the controls/menu 4s after they appear, so full screen
        // stays clean. Tapping the video brings them back (and restarts this).
        .task(id: showControls) {
            guard showControls else { return }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            withAnimation { showControls = false }
        }
    }

    private var airPlaySheet: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Image(systemName: "airplayvideo").font(.system(size: 46)).foregroundStyle(.tint)
                Text("Watch on your TV").font(.title2).bold()
                Text("VLC plays files natively but can't send video to AirPlay. Two ways to get it on the TV:")
                    .foregroundStyle(.secondary)
                Button {
                    openInSafariForAirPlay()
                } label: {
                    Label("Open in Safari (real AirPlay)", systemImage: "safari").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Text("Or: Control Center → Screen Mirroring → pick your Apple TV. That mirrors the whole screen, including this player.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding()
            .navigationTitle("AirPlay")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showAirPlayInfo = false } } }
        }
    }

    /// Hand off to Safari's native HLS player via HomeStream's converter — it
    /// supports the real AirPlay button and plays on the TV without mirroring.
    private func openInSafariForAirPlay() {
        guard let u = stream.streamURL?.absoluteString else { return }
        let enc = u.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? u
        let hls = "\(settings.serverURL)/api/tv/transcode?u=\(enc)&f=hls&vod=1"
        if let url = URL(string: hls) { UIApplication.shared.open(url) }
    }

    private func fmt(_ t: TimeInterval) -> String {
        let m = Int(t) / 60, s = Int(t) % 60
        return String(format: "%d:%02d", m, s)
    }
}
