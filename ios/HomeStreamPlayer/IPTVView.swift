import SwiftUI
import UIKit

struct IPTVView: View {
    @EnvironmentObject var settings: Settings
    @State private var channels: [IPTVChannel] = []
    @State private var filter = ""
    @State private var loading = true
    @State private var msg = ""
    @State private var playingIndex: Int? = nil
    @State private var showSources = false

    var body: some View {
        NavigationStack {
            Group {
                if loading { ProgressView("Loading channels…") }
                else if channels.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "tv").font(.system(size: 44)).foregroundStyle(.secondary)
                        Text("No channels yet").font(.headline)
                        Text("Tap Sources to upload an M3U playlist or add an Xtream login.").foregroundStyle(.secondary)
                        Button("Add sources") { showSources = true }.buttonStyle(.borderedProminent)
                    }
                } else {
                    List(filtered.indices, id: \.self) { i in
                        Button { playingIndex = filtered[i].1 } label: {
                            HStack {
                                AsyncImage(url: URL(string: filtered[i].0.logo ?? "")) { img in
                                    img.resizable().frame(width: 40, height: 40).cornerRadius(6)
                                } placeholder: { Image(systemName: "tv").frame(width: 40, height: 40) }
                                VStack(alignment: .leading) {
                                    Text(filtered[i].0.name).foregroundStyle(.primary)
                                    if let grp = filtered[i].0.group, !grp.isEmpty {
                                        Text(grp).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Live TV")
            .searchable(text: $filter, prompt: "Filter channels")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSources = true } label: { Image(systemName: "gearshape") }
                }
            }
            .task { await load() }
            .refreshable { await load() }
            .sheet(isPresented: $showSources) { SourcesView().onDisappear { Task { await load() } } }
            .fullScreenCover(item: Binding(
                get: { playingIndex.map { IPTVPlay(id: $0) } },
                set: { playingIndex = $0?.id }
            )) { item in
                if let u = URL(string: "\(settings.serverURL)/api/iptv/m3u/play?index=\(item.id)") {
                    NativeHLSPlayer(url: u).ignoresSafeArea()
                }
            }
        }
    }

    // Filtered pairs of (channel, original index) so playback still uses the
    // correct /api/tv index. SwiftUI's List is lazy — only visible rows render.
    private var filtered: [(IPTVChannel, Int)] {
        let q = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let pairs = channels.enumerated().map { ($0.element, $0.offset) }
        if q.isEmpty { return pairs }
        return pairs.filter { $0.0.name.lowercased().contains(q) || ($0.0.group ?? "").lowercased().contains(q) }
    }

    func load() async {
        loading = true
        let cacheURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("iptv-channels.json")
        // Show last-known channels from disk instantly while refreshing.
        if channels.isEmpty,
           let cached = try? Data(contentsOf: cacheURL),
           let d = try? JSONDecoder().decode(TVData.self, from: cached) {
            channels = d.channels ?? []
        }
        let data = try? await URLSession.shared.data(from: URL(string: "\(settings.serverURL)/api/tv")!).0
        if let data, let d = try? JSONDecoder().decode(TVData.self, from: data) {
            channels = d.channels ?? []
            try? data.write(to: cacheURL)
        }
        loading = false
    }

    struct TVData: Decodable { let channels: [IPTVChannel]? }
}

struct IPTVPlay: Identifiable { let id: Int }

struct IPTVChannel: Identifiable, Decodable {
    let name: String
    let logo: String?
    let group: String?
    let url: String?
    var id: String { url ?? name }
}

/// Add sources: M3U by URL / pasted text, or Xtream login (host + user + pass).
struct SourcesView: View {
    @EnvironmentObject var settings: Settings
    @Environment(\.dismiss) private var dismiss
    @State private var mode = 0
    @State private var m3uURL = ""
    @State private var m3uText = ""
    @State private var host = ""
    @State private var user = ""
    @State private var pass = ""
    @State private var status = ""

    var body: some View {
        NavigationStack {
            Form {
                Picker("Source type", selection: $mode) {
                    Text("M3U URL").tag(0)
                    Text("Paste M3U").tag(1)
                    Text("Xtream login").tag(2)
                }.pickerStyle(.segmented)

                if mode == 0 {
                    TextField("https://.../playlist.m3u8", text: $m3uURL)
                        .autocapitalization(.none).keyboardType(.URL)
                    Button("Add playlist") { Task { await addURL() } }
                } else if mode == 1 {
                    TextEditor(text: $m3uText).frame(height: 160)
                    Button("Import channels") { Task { await addText() } }
                } else {
                    TextField("Host (http://...)", text: $host).autocapitalization(.none).keyboardType(.URL)
                    TextField("Username", text: $user).autocapitalization(.none)
                    SecureField("Password", text: $pass)
                    Button("Save & sync") { Task { await addXtream() } }
                }
                if !status.isEmpty { Text(status).font(.caption) }
            }
            .navigationTitle("TV Sources")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    func post(_ path: String, _ body: [String: Any]) async {
        guard let u = URL(string: "\(settings.serverURL)\(path)") else { return }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let result = try? await URLSession.shared.data(for: req)
        let data = result?.0
        let res = result?.1
        let ok = (res as? HTTPURLResponse)?.statusCode == 200
        let j = (try? JSONSerialization.jsonObject(with: data ?? Data()) as? [String: Any]) ?? [:]
        status = ok ? "✅ \(j["added"] ?? j["ok"] ?? "Saved")" : "❌ \(j["error"] ?? "Failed")"
    }

    func addURL() async { await post("/api/tv", ["source": m3uURL]) }
    func addText() async {
        // Save pasted text to a temp file on the server via the data URL path.
        await post("/api/tv/import-text", ["text": m3uText])
    }
    func addXtream() async {
        await post("/api/settings/iptv", ["host": host, "username": user, "password": pass])
        status += " — sync on /tv page if needed"
    }
}
