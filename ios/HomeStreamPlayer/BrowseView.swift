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
    private let api = API(base: URL(string: "http://100.93.204.117:3000")!) // replaced on appear

    var body: some View {
        NavigationStack {
            Group {
                if !error.isEmpty { Text(error).foregroundStyle(.secondary) }
                else if items.isEmpty { ProgressView("Loading…") }
                else {
                    List(items) { m in
                        NavigationLink(value: m) {
                            MetaRow(meta: m)
                        }
                    }
                }
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
    var body: some View {
        NavigationStack {
            List(results) { m in NavigationLink(value: m) { MetaRow(meta: m) } }
                .navigationDestination(for: API.Meta.self) { m in DetailView(meta: m, type: (m.type ?? "movie")) }
                .searchable(text: $query)
                .navigationTitle("Search")
                .onSubmit { Task { await search() } }
        }
    }
    func search() async {
        // Search via Cinemeta, then open through HomeStream's resolve.
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        guard let u = URL(string: "https://v3-cinemeta.strem.io/catalog/movie/top/search=\(q).json") else { return }
        let data = try? await URLSession.shared.data(from: u).0
        results = (try? JSONDecoder().decode(Catalog.self, from: data ?? Data()))?.metas ?? []
    }
    struct Catalog: Decodable { let metas: [API.Meta] }
}
