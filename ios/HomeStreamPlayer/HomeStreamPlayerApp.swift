import SwiftUI

@main
struct HomeStreamPlayerApp: App {
    @StateObject private var settings = Settings.shared
    var body: some Scene {
        WindowGroup { RootView().environmentObject(settings) }
    }
}
