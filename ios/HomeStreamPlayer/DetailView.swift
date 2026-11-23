import SwiftUI

struct DetailView: View {
    let meta: API.Meta
    let type: String
    @EnvironmentObject var settings: Settings
    @State private var season = 1
    @State private var episode = 1
    @State private var loading = false
    @State private var error = ""
    @State private var playing: API.Stream?
    @State private var preloaded: API.Stream?      // warmed when the detail page opens
    @State private var preloadKey = ""             // which title/episode was warmed

    // Explicit init: @EnvironmentObject makes the memberwise initializer
    // private, so callers in BrowseView can't construct DetailView otherwise.
    init(meta: API.Meta, type: String) {
        self.meta = meta
        self.type = type
    }

    var isSeries: Bool { (type == "series") || (meta.type ?? "") == "series" }

    var body: some View {
        VStack(spacing: 16) {
            AsyncImage(url: meta.posterURL) { $0.resizable().frame(width: 150, height: 225).cornerRadius(8)
                } placeholder: { Color.gray.opacity(0.3).frame(width: 150, height: 225).cornerRadius(8) }
            Text(meta.name).font(.title2).bold().multilineTextAlignment(.center)
            if isSeries {
                HStack {
                    Stepper("S\(season)", value: $season, in: 1...40)
                    Stepper("E\(episode)", value: $episode, in: 1...99)
                }.padding(.horizontal)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).font(.caption) }
            if preloaded != nil && !loading {
                Text("Ready to play · started downloading").font(.caption).foregroundStyle(.green)
            }
            Button {
                Task { await play() }
            } label: {
                if loading { ProgressView() } else { Label("▶ Play", systemImage: "play.fill").frame(maxWidth: 240) }
            }
            .buttonStyle(.borderedProminent).disabled(loading)
            Spacer()
        }
        .padding().navigationTitle("Details")
        // Pre-warm the moment you land on a title (or change episode), so the
        // Play button starts instantly instead of waiting on Torrentio + load.
        .task(id: "\(meta.id)-\(season)-\(episode)") { await prewarm() }
        .sheet(item: $playing) { stream in
            PlayerView(stream: stream, title: meta.name,
                       resumeKey: "pos-\(meta.id)-\(isSeries ? "\(season)-\(episode)" : "")")
        }
    }

    func currentId() -> String {
        isSeries ? "\(meta.id):\(season):\(episode)" : meta.id
    }

    func prewarm() async {
        let key = currentId()
        preloadKey = key
        preloaded = nil
        // Resolve early — this is the slow part (addon query + engine load).
        preloaded = try? await API(base: settings.base).resolve(
            type: isSeries ? "series" : "movie", id: key,
            season: isSeries ? season : nil, episode: isSeries ? episode : nil)
    }

    func play() async {
        loading = true; error = ""
        let id = currentId()
        do {
            if preloadKey == id, let ready = preloaded {
                playing = ready                       // pre-warmed: instant
            } else {
                playing = try await API(base: settings.base).resolve(
                    type: isSeries ? "series" : "movie", id: id,
                    season: isSeries ? season : nil, episode: isSeries ? episode : nil)
            }
        } catch { self.error = "Couldn't load stream: \(error.localizedDescription)" }
        loading = false
    }
}
