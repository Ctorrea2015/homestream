import SwiftUI
import AVKit

/// Native HLS player for IPTV — AVPlayerViewController gives real AirPlay,
/// full controls, and native HLS handling (VLCKit can't do AirPlay).
struct NativeHLSPlayer: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        let player = AVPlayer(url: url)
        player.allowsExternalPlayback = true          // AirPlay
        vc.player = player
        vc.allowsPictureInPicturePlayback = true
        vc.exitsFullScreenWhenPlaybackEnds = true
        player.play()
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}
}
