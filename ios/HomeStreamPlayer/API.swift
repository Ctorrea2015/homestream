import Foundation

/// Thin client for HomeStream's addon surface. All playback goes through the
/// server's engines — the app just gets stream URLs and lets VLC play them.
struct API {
    let base: URL

    struct Meta: Identifiable, Decodable, Hashable {
        let id: String
        let type: String?
        let name: String
        let poster: String?
        let background: String?
        let description: String?
        let year: String?
        let runtime: String?
        let genres: [String]?
        let cast: [String]?
        let imdbRating: String?
        var posterURL: URL? { poster.flatMap { URL(string: $0) } }
        var backdropURL: URL? { background.flatMap { URL(string: $0) } ?? posterURL }
        var metaLine: String {
            [year, runtime, genres?.prefix(2).joined(separator: ", ")].compactMap { $0 }.joined(separator: " • ")
        }
    }

    struct Stream: Identifiable, Decodable {
        var id = UUID()
        let title: String
        let url: String
        let behaviorHints: Hint?
        enum CodingKeys: String, CodingKey { case title, url, behaviorHints }
        struct Hint: Decodable { let notWebReady: Bool? }
        var streamURL: URL? { URL(string: url) }
        var isAuto: Bool { title.contains("Auto") }
    }

    private func get(_ path: String) async throws -> Data {
        var url = base.appendingPathComponent(path)
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.percentEncodedPath = c.path // keep ':' in series ids
        url = c.url!
        let (data, res) = try await URLSession.shared.data(from: url)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.http((res as? HTTPURLResponse)?.statusCode ?? 0) }
        return data
    }

    enum APIError: Error { case http(Int) }

    struct Episode: Identifiable, Decodable, Hashable {
        let id: String
        let name: String?
        let season: Int?
        let episode: Int?
        let overview: String?
        let thumbnail: String?
        var title: String { name ?? "Episode \(episode ?? 0)" }
        var thumbURL: URL? { thumbnail.flatMap { URL(string: $0) } }
    }

    /// Episode list for a series from Cinemeta (videos[] with name/season/episode).
    func episodes(id: String) async throws -> [Episode] {
        let u = URL(string: "https://v3-cinemeta.strem.io/meta/series/\(id).json")!
        let (data, res) = try await URLSession.shared.data(from: u)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.http((res as? HTTPURLResponse)?.statusCode ?? 0) }
        let videos = (try? JSONDecoder().decode(CinemetaMetaResponse.self, from: data))?.meta?.videos ?? []
        // Drop specials (season 0) and sort by season/episode.
        return videos.filter { ($0.season ?? 0) > 0 }
            .sorted { (a, b) in
                let sa = a.season ?? 0, sb = b.season ?? 0
                if sa != sb { return sa < sb }
                return (a.episode ?? 0) < (b.episode ?? 0)
            }
    }

    /// Catalog rows — Cinemeta's Popular rows (the Pi's own library catalog is
    /// empty when you stream everything, so use real titles for discovery).
    func catalog(type: String) async throws -> [Meta] {
        let u = URL(string: "https://v3-cinemeta.strem.io/catalog/\(type)/top.json")!
        let (data, res) = try await URLSession.shared.data(from: u)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.http((res as? HTTPURLResponse)?.statusCode ?? 0) }
        return (try? JSONDecoder().decode(CatalogResponse.self, from: data))?.metas ?? []
    }
    private struct CatalogResponse: Decodable { let metas: [Meta] }

    /// Meta for a title (our route proxies Cinemeta for tt ids).
    func meta(type: String, id: String) async throws -> Meta? {
        let d = try await get("/stremio/meta/\(type)/\(id).json")
        return (try? JSONDecoder().decode(MetaResponse.self, from: d))?.meta
    }
    private struct MetaResponse: Decodable { let meta: Meta? }

    /// Resolve an IMDb id to the best playable stream URL (already loaded into
    /// the primary engine by HomeStream). This is the one-tap "⚡ Auto" path.
    func resolve(type: String, id: String, season: Int?, episode: Int?) async throws -> Stream {
        var comps = URLComponents(url: base.appendingPathComponent("/api/torrent/resolve"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "id", value: id), URLQueryItem(name: "type", value: type)]
        if let s = season { items.append(URLQueryItem(name: "s", value: String(s))) }
        if let e = episode { items.append(URLQueryItem(name: "e", value: String(e))) }
        comps.queryItems = items
        let (data, res) = try await URLSession.shared.data(from: comps.url!)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.http((res as? HTTPURLResponse)?.statusCode ?? 0) }
        struct R: Decodable { let ok: Bool; let streamUrl: String?; let title: String?; let error: String? }
        let r = try JSONDecoder().decode(R.self, from: data)
        guard r.ok, let u = r.streamUrl else { throw APIError.http(502) }
        return Stream(title: r.title ?? "Auto", url: u, behaviorHints: nil)
    }

    /// Full ranked source list for manual pick.
    func streams(type: String, id: String) async throws -> [Stream] {
        let d = try await get("/stremio/stream/\(type)/\(id).json")
        return (try? JSONDecoder().decode(StreamsResponse.self, from: d))?.streams ?? []
    }
    private struct StreamsResponse: Decodable { let streams: [Stream] }
}
