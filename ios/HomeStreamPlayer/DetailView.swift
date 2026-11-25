import SwiftUI
import UIKit

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
    @State private var favorite = false
    @State private var dlNote = false
    @Environment(\.dismiss) private var dismiss

    // Explicit init: @EnvironmentObject makes the memberwise initializer
    // private, so callers in BrowseView can't construct DetailView otherwise.
    init(meta: API.Meta, type: String) {
        self.meta = meta
        self.type = type
    }

    var isSeries: Bool { (type == "series") || (meta.type ?? "") == "series" }

    var body: some View {
        ScrollView {
            // Full-bleed backdrop with overlaid back/favorite and orange Play.
            ZStack(alignment: .top) {
                AsyncImage(url: meta.backdropURL) { img in
                    img.resizable().scaledToFill().frame(height: 360).clipped()
                } placeholder: {
                    LinearGradient(colors: [.gray.opacity(0.4), .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: 360)
                }
                LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 360)
                HStack {
                    Button { dismiss() } label: { Image(systemName: "chevron.left").font(.title3) }
                    Spacer()
                    Button { favorite.toggle() } label: {
                        Image(systemName: favorite ? "heart.fill" : "heart").font(.title3)
                    }
                }
                .foregroundStyle(.white).padding(.horizontal, 20).padding(.top, 12)
                // Orange play button anchored bottom-right of the backdrop.
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button {
                            Task { await play() }
                        } label: {
                            if loading { ProgressView().tint(.white) }
                            else { Image(systemName: "play.fill").font(.title2) }
                        }
                        .foregroundStyle(.white)
                        .frame(width: 62, height: 62)
                        .background(Color.orange, in: Circle())
                        .disabled(loading)
                    }
                }
                .frame(height: 360).padding(.trailing, 22).padding(.bottom, 18)
            }

            VStack(alignment: .leading, spacing: 10) {
                Text(meta.name).font(.title).bold()
                HStack(spacing: 8) {
                    Text(meta.metaLine).font(.subheadline).foregroundStyle(.secondary)
                    Text("HD").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                HStack(spacing: 6) {
                    Image(systemName: "star.fill").foregroundStyle(.yellow).font(.caption)
                    Text(meta.imdbRating ?? "—").font(.subheadline).bold()
                    Text("1.2K reviews").font(.caption).foregroundStyle(.secondary)
                }
                if let d = meta.description, !d.isEmpty {
                    Text(d).font(.subheadline).foregroundStyle(.secondary).lineLimit(4)
                }

                // Prominent Play button — always visible in portrait (the
                // backdrop overlay button can be hard to reach).
                Button {
                    Task { await play() }
                } label: {
                    if loading { ProgressView().tint(.white).frame(maxWidth: .infinity) }
                    else { Label("Play", systemImage: "play.fill").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .disabled(loading)

                // Episodes (series only)
                if isSeries {
                    Button { showEpisodes = true } label: {
                        Label("Episodes (\(episodes.count))", systemImage: "list.bullet").frame(maxWidth: .infinity)
                    }.buttonStyle(.bordered)
                    HStack {
                        Stepper("S\(season)", value: $season, in: 1...40)
                        Stepper("E\(episode)", value: $episode, in: 1...99)
                    }
                }

                // Action buttons: My List / Download (Safari handoff) / Share
                HStack(spacing: 32) {
                    Button {
                        favorite.toggle()
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: favorite ? "checkmark.circle.fill" : "plus").font(.title3)
                            Text("My List").font(.caption2)
                        }
                    }
                    Button {
                        if let u = streamURLForShare() { UIApplication.shared.open(u) }
                        dlNote = true
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "arrow.down.to.line").font(.title3)
                            Text("Download").font(.caption2)
                        }
                    }
                    if let shareURL = streamURLForShare() {
                        ShareLink(item: shareURL) {
                            VStack(spacing: 4) {
                                Image(systemName: "square.and.arrow.up").font(.title3)
                                Text("Share").font(.caption2)
                            }
                        }
                    }
                }
                .foregroundStyle(.primary).padding(.vertical, 6)
                if dlNote { Text("Opened in Safari — use Share → Save to Files to keep it").font(.caption2).foregroundStyle(.secondary) }

                if !error.isEmpty { Text(error).foregroundStyle(.red).font(.caption) }
                if preloaded != nil && !loading {
                    Text("Ready to play · started downloading").font(.caption).foregroundStyle(.green)
                }

                // Cast
                if let cast = meta.cast, !cast.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Cast").font(.headline)
                            Spacer()
                            Text("View all").font(.caption).foregroundStyle(.orange)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 14) {
                                ForEach(cast.prefix(10), id: \.self) { name in
                                    VStack(spacing: 4) {
                                        ZStack {
                                            Circle().fill(Color.gray.opacity(0.3)).frame(width: 54, height: 54)
                                            Text(initials(name)).font(.headline).foregroundStyle(.white)
                                        }
                                        Text(name).font(.caption2).lineLimit(1).frame(width: 54)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.top, 6)
                }
            }
            .padding(.horizontal, 20)
        }
        .background(Color.black.ignoresSafeArea())
        .navigationBarHidden(true)
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

    /// A URL for Download/Share — resolve through the server so it opens a
    /// real playable stream (Safari handoff for Download).
    func streamURLForShare() -> URL? {
        // /api/torrent/resolve returns JSON, not a playable stream. Point
        // Safari at the converter HLS instead so Download/Share shows video.
        let enc = currentId().addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? currentId()
        let src = "\(settings.serverURL)/api/torrent/resolve?id=\(enc)&type=\(isSeries ? "series" : "movie")"
        let srcEnc = src.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? src
        return URL(string: "\(settings.serverURL)/api/tv/transcode?u=\(srcEnc)&f=hls&vod=1")
    }

    func initials(_ name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined()
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
                                    AsyncImage(url: u) { phase in
                                        if let img = phase.image {
                                            img.resizable().scaledToFill().frame(width: 70, height: 40).clipped().cornerRadius(4)
                                        } else {
                                            Color.gray.opacity(0.3).frame(width: 70, height: 40).cornerRadius(4)
                                        }
                                    }
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
