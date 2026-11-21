import SwiftUI

struct IPTVView: View {
    @EnvironmentObject var settings: Settings
    @State private var categories: [IPTVCategory] = []
    @State private var channels: [IPTVChannel] = []
    @State private var selectedCategory: String? = nil
    @State private var playing: IPTVChannel? = nil
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Group {
                if !error.isEmpty {
                    VStack(spacing: 12) {
                        Text(error).foregroundStyle(.secondary)
                        Button("Retry") { Task { await load() } }
                    }
                } else if channels.isEmpty {
                    ProgressView("Loading channels…")
                } else {
                    List {
                        // Category filter chips (horizontal scroll).
                        ScrollView(.horizontal) {
                            HStack {
                                CategoryChip(title: "All", active: selectedCategory == nil) {
                                    selectedCategory = nil; Task { await load() } }
                                ForEach(categories) { c in
                                    CategoryChip(title: c.name, active: selectedCategory == c.id) {
                                        selectedCategory = c.id; Task { await load() } }
                                }
                            }
                        }
                        ForEach(channels) { ch in
                            Button { playing = ch } label: {
                                HStack {
                                    AsyncImage(url: URL(string: ch.logo ?? "")) { img in
                                        img.resizable().frame(width: 40, height: 40).cornerRadius(6)
                                    } placeholder: {
                                        Image(systemName: "tv").frame(width: 40, height: 40)
                                    }
                                    Text(ch.name).foregroundStyle(.primary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Live TV")
            .task { await load() }
            .refreshable { await load() }
            .fullScreenCover(item: $playing) { ch in
                if let u = URL(string: "\(settings.serverURL)/api/iptv/live/\(ch.numericId)") {
                    NativeHLSPlayer(url: u)
                        .ignoresSafeArea()
                }
            }
        }
    }

    func load() async {
        do {
            var url = "\(settings.serverURL)/api/iptv/cache"
            if let cat = selectedCategory {
                url += "?category=\(cat.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? cat)"
            }
            let (data, res) = try await URLSession.shared.data(from: URL(string: url)!)
            guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "iptv", code: 1) }
            let d = try JSONDecoder().decode(Cache.self, from: data)
            categories = d.categories ?? []
            channels = d.channels ?? []
            error = ""
        } catch let e { error = "Couldn't load channels: \(e.localizedDescription)" }
    }

    struct Cache: Decodable { let categories: [IPTVCategory]?; let channels: [IPTVChannel]? }
}

struct IPTVCategory: Identifiable, Decodable {
    let id: String
    let name: String
}

struct IPTVChannel: Identifiable, Decodable {
    let numericId: String
    let name: String
    let logo: String?
    var id: String { numericId }
}

struct CategoryChip: View {
    let title: String
    let active: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.caption).padding(.horizontal, 12).padding(.vertical, 6)
                .background(active ? Color.accentColor : Color.gray.opacity(0.2))
                .foregroundStyle(active ? .white : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
