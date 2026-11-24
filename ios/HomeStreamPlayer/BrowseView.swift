import SwiftUI

struct RootView: View {
    @EnvironmentObject var settings: Settings
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            BrowseView(type: "movie").tabItem { Label("Movies", systemImage: "film") }.tag(0)
            BrowseView(type: "series").tabItem { Label("Shows", systemImage: "tv") }.tag(1)
            SearchView().tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(2)
            IPTVView().tabItem { Label("Live TV", systemImage: "tv") }.tag(3)
            SettingsView().tabItem { Label("Settings", systemImage: "gear") }.tag(4)
        }
    }
}

struct BrowseView: View {
    let type: String
    @EnvironmentObject var settings: Settings
    @State private var items: [API.Meta] = []
    @State private var error = ""
    var body: some View {
        NavigationStack {
            Group {
                if !error.isEmpty { Text(error).foregroundStyle(.secondary) }
                else if items.isEmpty { ProgressView("Loading…") }
                else { List(items) { m in NavigationLink(value: m) { MetaRow(meta: m) } } }
            }
            .navigationTitle(type == "movie" ? "Movies" : "Shows")
            .navigationDestination(for: API.Meta.self) { m in DetailView(meta: m, type: type) }
            .task { await load() }
            .refreshable { await load() }
        }
    }
    func load() async {
        do { items = try await API(base: settings.base).catalog(type: type); error = "" }
        catch { self.error = "Couldn't reach HomeStream: \(error.localizedDescription)" }
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
