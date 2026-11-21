import SwiftUI
import MobileVLCKit
import UIKit

/// UIViewRepresentable wrapping VLCMediaPlayer — plays mkv/HEVC/10-bit/DDP
/// natively on iOS, no server-side transcoding. That's the whole point of
/// the native app: the Pi just supplies bytes, the iPhone decodes.
struct VLCPlayerView: UIViewRepresentable {
    let url: URL
    let startPosition: Float?          // 0...1 resume
    let onProgress: (Float, TimeInterval) -> Void
    let onFinished: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onProgress: onProgress, onFinished: onFinished) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        let player = VLCMediaPlayer()
        player.delegate = context.coordinator
        player.drawable = view
        context.coordinator.player = player
        player.media = VLCMedia(url: url)
        if let p = startPosition, p > 0 { player.position = p }
        player.play()
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.player?.stop()
    }

    final class Coordinator: NSObject, VLCMediaPlayerDelegate {
        let onProgress: (Float, TimeInterval) -> Void
        let onFinished: () -> Void
        var player: VLCMediaPlayer?
        init(onProgress: @escaping (Float, TimeInterval) -> Void, onFinished: @escaping () -> Void) {
            self.onProgress = onProgress; self.onFinished = onFinished
        }
        func mediaPlayerTimeChanged(_ aNotification: Notification!) {
            guard let p = player else { return }
            onProgress(p.position, TimeInterval(p.time.intValue))
        }
        func mediaPlayerStateChanged(_ aNotification: Notification!) {
            guard let p = player else { return }
            if p.state == .ended { onFinished() }
        }
    }
}
