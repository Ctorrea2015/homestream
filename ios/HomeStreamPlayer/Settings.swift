import Foundation
import Combine

/// Server settings — LAN address and Tailscale both work. Auto-detected, overridable.
final class Settings: ObservableObject {
    static let shared = Settings()
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    init() {
        self.serverURL = UserDefaults.standard.string(forKey: "serverURL")
            ?? "http://100.93.204.117:3000" // Tailscale default; change to LAN if preferred
    }
    var base: URL { URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines))! }
}
