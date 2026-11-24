import SwiftUI

struct RootView: View {
    @EnvironmentObject var settings: Settings
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            BrowseView(type: "movie").tabItem { Label("Home", systemImage: "house.fill") }.tag(0)
            BrowseView(type: "series").tabItem { Label("Shows", systemImage: "tv.fill") }.tag(1)
            SearchView().tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(2)
            IPTVView().tabItem { Label("Live TV", systemImage: "square.stack.fill") }.tag(3)
            SettingsView().tabItem { Label("Profile", systemImage: "person.crop.circle") }.tag(4)
        }
        .tint(.orange)
    }
}

struct BrowseView: View {
    let type: String
    @EnvironmentObject var settings: Settings
    @State private var items: [API.Meta] = []
    @State private var error = ""
    @State private var chip = "All"

    private var chips: [String] { ["All", "Popular", "Trending", type == "movie" ? "Movies" : "Shows"] }

    var body: some View {
        NavigationStack {
            Group {
                if !error.isEmpty {
                    Text(error).foregroundStyle(.secondary)
                } else if items.isEmpty {
                    ProgressView("Loading…")
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            // Header
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Stream Top-Quality").font(.largeTitle).bold()
                                Text(type == "movie" ? "Movies" : "Shows").font(.largeTitle).bold()
                                Text("Discover premium titles").font(.subheadline).foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 20)

                            // Hero card
                            if let hero = items.first {
                                NavigationLink(value: hero) {
                                    ZStack(alignment: .bottomLeading) {
                                        AsyncImage(url: hero.backdropURL) { img in
                                            img.resizable().scaledToFill().frame(height: 260).clipped()
                                        } placeholder: {
                                            Color.gray.opacity(0.3).frame(height: 260)
                                        }
                                        LinearGradient(colors: [.clear, .black.opacity(0.9)], startPoint: .top, endPoint: .bottom)
                                            .frame(height: 260)
                                        VStack(alignment: .leading, spacing: 6) {
                                            Text(hero.name).font(.title2).bold().foregroundStyle(.white)
                                            Text(hero.metaLine).font(.caption).foregroundStyle(.white.opacity(0.8))
                                            HStack {
                                                Label("PLAY", systemImage: "play.fill").font(.caption.bold())
                                                    .padding(.horizontal, 14).padding(.vertical, 8)
                                                    .background(Color.orange, in: Capsule()).foregroundStyle(.white)
                                                Spacer()
                                            }
                                        }
                                        .padding(16)
                                    }
                                    .cornerRadius(16)
                                    .padding(.horizontal, 20)
                                }
                                .buttonStyle(.plain)
                            }

                            // Category chips
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 10) {
                                    ForEach(chips, id: \.self) { c in
                                        Button { chip = c } label: {
                                            Text(c).font(.subheadline.weight(.semibold))
                                                .padding(.horizontal, 16).padding(.vertical, 8)
                                                .background(chip == c ? Color.white : Color.white.opacity(0.12), in: Capsule())
                                                .foregroundStyle(chip == c ? Color.black : Color.white)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                .padding(.horizontal, 20)
                            }

                            // Poster rows
                            PosterRow(title: "Trending Now", items: items, settings: settings)
                            if items.count > 6 {
                                PosterRow(title: "More \(type == "movie" ? "Movies" : "Shows")", items: Array(items.dropFirst(6)), settings: settings)
                            }
                        }
                        .padding(.top, 8)
                    }
                }
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("")
            .navigationBarHidden(true)
            .navigationDestination(for: API.Meta.self) { m in DetailView(meta: m, type: m.type ?? type) }
            .task { await load() }
            .refreshable { await load() }
        }
    }
    func load() async {
        do { items = try await API(base: settings.base).catalog(type: type); error = "" }
        catch { self.error = "Couldn't reach HomeStream: \(error.localizedDescription)" }
    }
}

struct PosterRow: View {
    let title: String
    let items: [API.Meta]
    let settings: Settings
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline).foregroundStyle(.white).padding(.horizontal, 20)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(items) { m in
                        NavigationLink(value: m) {
                            VStack(spacing: 6) {
                                AsyncImage(url: m.posterURL) { img in
                                    img.resizable().frame(width: 110, height: 165).cornerRadius(8)
                                } placeholder: {
                                    Color.gray.opacity(0.3).frame(width: 110, height: 165).cornerRadius(8)
                                }
                                Text(m.name).font(.caption).lineLimit(1).frame(width: 110).foregroundStyle(.white)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
            }
        }
    }
}

struct MetaRow: View {
    let meta: API.Meta
    var body: some View {
        HStack {
            AsyncImage(url: meta.posterURL) { img in img.resizable().frame(width: 46, height: 68).cornerRadius(4)
                } placeholder: { Color.gray.opacity(0.3).frame(width: 46, height: 68).cornerRadius(4) }
            Text(meta.name).font(.body)
        }
    }
}

struct SearchView: View {
    @EnvironmentObject var settings: Settings
    @State private var query = ""
    @State private var results: [API.Meta] = []
    @State private var searching = false

    var body: some View {
        NavigationStack {
            Group {
                if searching { ProgressView("Searching…") }
                else if !query.isEmpty && results.isEmpty {
                    Text("No results for \"\(query)\"").foregroundStyle(.secondary)
                } else if results.isEmpty {
                    Text("Type a movie or show title above").foregroundStyle(.secondary)
                } else {
                    List(results) { m in NavigationLink(value: m) { MetaRow(meta: m) } }
                }
            }
            .navigationDestination(for: API.Meta.self) { m in DetailView(meta: m, type: (m.type ?? "movie")) }
            .searchable(text: $query, prompt: "Movie or show title")
            .navigationTitle("Search")
            // Live search as you type — no need to press return.
            .task(id: query) { await search(query) }
        }
    }

    func search(_ text: String) async {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { results = []; return }
        searching = true
        // Strict percent-encoding (spaces -> %20, not '+') so Cinemeta parses it.
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let enc = q.addingPercentEncoding(withAllowedCharacters: allowed) ?? q
        // Search BOTH catalogs — previously only /movie/ was queried, so TV
        // shows never appeared in the Search tab (2026-11-24).
        async let movieData = fetchCatalog("movie", enc)
        async let seriesData = fetchCatalog("series", enc)
        let movies = await movieData
        let series = await seriesData
        // Combine, dedupe by id (a title can appear in both catalogs).
        var seen = Set<String>()
        var merged: [API.Meta] = []
        for m in movies + series where seen.insert(m.id).inserted { merged.append(m) }
        results = merged
        searching = false
    }

    func fetchCatalog(_ type: String, _ enc: String) async -> [API.Meta] {
        let urlStr = "https://cinemeta-live.strem.io/catalog/\(type)/top/search=\(enc).json"
        guard let url = URL(string: urlStr),
              let data = try? await URLSession.shared.data(from: url).0 else { return [] }
        return (try? JSONDecoder().decode(Catalog.self, from: data))?.metas ?? []
    }
    struct Catalog: Decodable { let metas: [API.Meta] }
}
