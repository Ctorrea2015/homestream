import SwiftUI

/// Full-screen player: VLC native playback + controls + resume position saved
/// per title in UserDefaults.
struct PlayerView: View {
    let stream: API.Stream
    let title: String
    let resumeKey: String

    @State private var position: Float = 0
    @State private var time: TimeInterval = 0
    @State private var showControls = true
    @State private var playerID = 0
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
                .ignoresSafeArea()
                .onTapGesture { withAnimation { showControls.toggle() } }

            if showControls {
                VStack {
                    HStack {
                        Button { dismiss() } label: { Image(systemName: "chevron.left").font(.title2) }
                        Spacer()
                        Text(title).font(.headline).lineLimit(1)
                        Spacer()
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
                            .onChange(of: position) { _, v in saved.set(v, forKey: resumeKey) }
                        HStack {
                            Button { saved.removeObject(forKey: resumeKey); playerID += 1 } label: {
                                Label("Restart", systemImage: "gobackward.10")
                            }
                            Spacer()
                            Text("Tap to show controls").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    .padding()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func fmt(_ t: TimeInterval) -> String {
        let m = Int(t) / 60, s = Int(t) % 60
        return String(format: "%d:%02d", m, s)
    }
}
