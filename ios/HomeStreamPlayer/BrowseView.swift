import SwiftUI

struct RootView: View {
    @EnvironmentObject var settings: Settings
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            BrowseView(type: "movie").tabItem { Label("Movies", systemImage: "film") }.tag(0)
            BrowseView(type: "series").tabItem { Label("Shows", systemImage: "tv") }.tag(1)
            SearchView().tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(2)
            SettingsView().tabItem { Label("Settings", systemImage: "gear") }.tag(3)
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
        let urlStr = "https://cinemeta-live.strem.io/catalog/movie/top/search=\(enc).json"
        let data = try? await URLSession.shared.data(from: URL(string: urlStr)!).0
        let found = (try? JSONDecoder().decode(Catalog.self, from: data ?? Data()))?.metas ?? []
        results = found
        searching = false
    }
    struct Catalog: Decodable { let metas: [API.Meta] }
}
