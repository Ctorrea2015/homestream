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
    // Audio-track picker support: the coordinator reports the available tracks
    // once the media is parsed, and the parent can switch by index.
    var onAudioTracks: (([(index: Int, name: String)], Int) -> Void)? = nil
    @Binding var selectedAudioTrack: Int

    func makeCoordinator() -> Coordinator {
        Coordinator(onProgress: onProgress, onFinished: onFinished, onPlaying: onPlaying,
                    onError: onError, onAudioTracks: onAudioTracks, selectedAudioTrack: $selectedAudioTrack)
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

    func updateUIView(_ uiView: UIView, context: Context) {
        // When the user picks a track, apply it to the live player.
        context.coordinator.applyAudioTrack(selectedAudioTrack)
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.player?.stop()
    }

    final class Coordinator: NSObject, VLCMediaPlayerDelegate {
        let onProgress: (Float, TimeInterval) -> Void
        let onFinished: () -> Void
        let onPlaying: () -> Void
        let onError: (String) -> Void
        var player: VLCMediaPlayer?
        var onAudioTracks: (([(index: Int, name: String)], Int) -> Void)?
        var selectedAudioTrack: Binding<Int>
        var tracksReported = false
        init(onProgress: @escaping (Float, TimeInterval) -> Void,
             onFinished: @escaping () -> Void,
             onPlaying: @escaping () -> Void,
             onError: @escaping (String) -> Void,
             onAudioTracks: (([(index: Int, name: String)], Int) -> Void)?,
             selectedAudioTrack: Binding<Int>) {
            self.onProgress = onProgress; self.onFinished = onFinished
            self.onPlaying = onPlaying; self.onError = onError
            self.onAudioTracks = onAudioTracks; self.selectedAudioTrack = selectedAudioTrack
        }

        /// Publish the available audio tracks once VLC has parsed the media.
        func reportAudioTracksIfNeeded() {
            guard !tracksReported, let p = player else { return }
            let rawIndexes = p.audioTrackIndexes as? [Any] ?? []
            let indexes: [Int] = rawIndexes.compactMap { v in
                if let n = v as? NSNumber { return n.intValue }
                if let i = v as? Int { return i }
                return nil
            }
            guard indexes.count > 1 else { return } // no choice to offer
            let rawNames = p.audioTrackNames as? [Any] ?? []
            var tracks: [(index: Int, name: String)] = []
            for (i, idx) in indexes.enumerated() {
                let name: String
                if i < rawNames.count {
                    if let s = rawNames[i] as? String { name = s }
                    else if let n = rawNames[i] as? NSNumber { name = "Track \(n.intValue)" }
                    else { name = "Track \(i + 1)" }
                } else { name = "Track \(i + 1)" }
                tracks.append((index: idx, name: name))
            }
            let current = Int(p.currentAudioTrackIndex)
            tracksReported = true
            let cb = onAudioTracks
            DispatchQueue.main.async { cb?(tracks, current) }
        }

        /// Apply a chosen track index (called from updateUIView when binding changes).
        func applyAudioTrack(_ index: Int) {
            guard let p = player, index >= 0 else { return }
            if Int(p.currentAudioTrackIndex) != index {
                p.currentAudioTrackIndex = Int32(index)
            }
        }

        func mediaPlayerTimeChanged(_ aNotification: Notification) {
            guard let p = player else { return }
            reportAudioTracksIfNeeded() // tracks become available after playback starts
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
