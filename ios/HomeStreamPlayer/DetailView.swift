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
            Button {
                Task { await play() }
            } label: {
                if loading { ProgressView() } else { Label("▶ Play", systemImage: "play.fill").frame(maxWidth: 240) }
            }
            .buttonStyle(.borderedProminent).disabled(loading)
            Spacer()
        }
        .padding().navigationTitle("Details")
        .sheet(item: $playing) { stream in
            PlayerView(stream: stream, title: meta.name,
                       resumeKey: "pos-\(meta.id)-\(isSeries ? "\(season)-\(episode)" : "")")
        }
    }

    func play() async {
        loading = true; error = ""
        let id = isSeries ? "\(meta.id):\(season):\(episode)" : meta.id
        do {
            playing = try await API(base: settings.base).resolve(
                type: isSeries ? "series" : "movie", id: id,
                season: isSeries ? season : nil, episode: isSeries ? episode : nil)
        } catch { self.error = "Couldn't load stream: \(error.localizedDescription)" }
        loading = false
    }
}
