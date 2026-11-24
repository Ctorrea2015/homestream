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
    @State private var episodes: [API.Episode] = []
    @State private var showEpisodes = false

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
                // Episode picker by title (from Cinemeta), with steppers as fallback.
                Button {
                    showEpisodes = true
                } label: {
                    Label("Episodes (\(episodes.count))", systemImage: "list.bullet")
                        .frame(maxWidth: 240)
                }
                .buttonStyle(.bordered)
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
        .task { if isSeries { episodes = (try? await API(base: settings.base).episodes(id: meta.id)) ?? [] } }
        .sheet(isPresented: $showEpisodes) {
            EpisodeList(episodes: episodes, currentSeason: season, currentEpisode: episode) { s, e in
                season = s; episode = e; showEpisodes = false
            }
        }
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

/// Series episode picker with real titles from Cinemeta.
struct EpisodeList: View {
    let episodes: [API.Episode]
    let currentSeason: Int
    let currentEpisode: Int
    let pick: (Int, Int) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if episodes.isEmpty {
                    Text("No episode list available for this show").foregroundStyle(.secondary)
                } else {
                    List(episodes) { ep in
                        Button {
                            pick(ep.season ?? 1, ep.episode ?? 1)
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                if let u = ep.thumbURL {
                                    AsyncImage(url: u) { $0.resizable().frame(width: 70, height: 40).cornerRadius(4) }
                                        .frame(width: 70, height: 40)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("S\(ep.season ?? 0)E\(ep.episode ?? 0)  \(ep.title)")
                                        .font(.subheadline).lineLimit(2)
                                    if let o = ep.overview, !o.isEmpty {
                                        Text(o).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                                Spacer()
                                if ep.season == currentSeason && ep.episode == currentEpisode {
                                    Image(systemName: "checkmark").foregroundStyle(.blue)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle("Episodes")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
