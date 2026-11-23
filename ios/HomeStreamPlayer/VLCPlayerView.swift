import SwiftUI
import MobileVLCKit
import UIKit

/// UIViewRepresentable wrapping VLCMediaPlayer — plays mkv/HEVC/10-bit/DDP
/// natively on iOS, no server-side transcoding. Reports state so the UI can
/// show a timeout + Safari fallback if this device's VLC can't start.
struct VLCPlayerView: UIViewRepresentable {
    let url: URL
    let startPosition: Float?
    let onProgress: (Float, TimeInterval) -> Void
    let onFinished: () -> Void
    let onPlaying: () -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onProgress: onProgress, onFinished: onFinished, onPlaying: onPlaying, onError: onError)
    }

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
        let onPlaying: () -> Void
        let onError: (String) -> Void
        var player: VLCMediaPlayer?
        init(onProgress: @escaping (Float, TimeInterval) -> Void,
             onFinished: @escaping () -> Void,
             onPlaying: @escaping () -> Void,
             onError: @escaping (String) -> Void) {
            self.onProgress = onProgress; self.onFinished = onFinished
            self.onPlaying = onPlaying; self.onError = onError
        }
        func mediaPlayerTimeChanged(_ aNotification: Notification) {
            guard let p = player else { return }
            onProgress(p.position, TimeInterval(p.time.intValue))
        }
        func mediaPlayerStateChanged(_ aNotification: Notification) {
            guard let p = player else { return }
            switch p.state {
            case .playing: onPlaying()
            case .ended: onFinished()
            case .error: onError("VLC couldn't open this stream")
            default: break
            }
        }
    }
}
