import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var settings: Settings
    @State private var draft = ""
    @State private var status = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("HomeStream server") {
                    TextField("http://100.93.204.117:3000", text: $draft)
                        .autocapitalization(.none).disableAutocorrection(true)
                        .keyboardType(.URL)
                    Button("Test & Save") { Task { await test() } }
                    if !status.isEmpty { Text(status).font(.caption) }
                }
                Section("About") {
                    Text("Plays torrent streams directly from your server with native MKV/HEVC decode — no server-side conversion. Point it at the LAN or Tailscale address; both work.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .onAppear { draft = settings.serverURL }
        }
    }
    func test() async {
        settings.serverURL = draft
        do {
            let d = try await API(base: settings.base).getHealth()
            status = d ? "✅ Connected" : "❌ No response"
        } catch { status = "❌ \(error.localizedDescription)" }
    }
}

extension API {
    func getHealth() async throws -> Bool {
        let (_, res) = try await URLSession.shared.data(from: base.appendingPathComponent("/api/rqbit/health"))
        return (res as? HTTPURLResponse)?.statusCode == 200
    }
}
