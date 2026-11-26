import SwiftUI
import MobileVLCKit
import UIKit

/// UIViewRepresentable wrapping VLCMediaPlayer — plays mkv/HEVC/10-bit/DDP
/// natively on iOS, no server-side transcoding. Reports state so the UI can
/// show a timeout + Safari fallback if this device's VLC can't start.
struct VLCPlayerView: UIViewRepresentable {
    let url: URL
    let startPosition: Float?
    // Seek commands from the parent: set to a 0...1 position to seek, -1 = idle.
    @Binding var seekTo: Float
    @Binding var isPaused: Bool      // center play/pause toggle
    @Binding var volume: Float       // 0...1, top-right volume slider
    let onProgress: (Float, TimeInterval) -> Void
    let onDuration: (TimeInterval) -> Void
    let onFinished: () -> Void
    let onPlaying: () -> Void
    let onError: (String) -> Void
    // Audio-track picker support: the coordinator reports the available tracks
    // once the media is parsed, and the parent can switch by index.
    var onAudioTracks: (([(index: Int, name: String)], Int) -> Void)? = nil
    @Binding var selectedAudioTrack: Int

    func makeCoordinator() -> Coordinator {
        Coordinator(onProgress: onProgress, onDuration: onDuration, onFinished: onFinished, onPlaying: onPlaying,
                    onError: onError, onAudioTracks: onAudioTracks, selectedAudioTrack: $selectedAudioTrack,
                    seekTo: $seekTo, startPosition: startPosition, isPaused: $isPaused, volume: $volume)
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        let player = VLCMediaPlayer()
        player.delegate = context.coordinator
        player.drawable = view
        context.coordinator.player = player
        player.media = VLCMedia(url: url)
        player.play()
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // When the user picks a track, apply it to the live player.
        context.coordinator.applyAudioTrack(selectedAudioTrack)
        // When the parent requests a seek, apply it and clear the command.
        context.coordinator.applySeekIfNeeded()
        // Play/pause + volume from the parent's controls.
        context.coordinator.applyPlaybackState(isPaused: isPaused)
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
        var seekTo: Binding<Float>
        var isPaused: Binding<Bool>
        var volume: Binding<Float>
        let startPosition: Float?
        var tracksReported = false
        var initialSeekDone = false
        let onDuration: (TimeInterval) -> Void
        init(onProgress: @escaping (Float, TimeInterval) -> Void,
             onDuration: @escaping (TimeInterval) -> Void,
             onFinished: @escaping () -> Void,
             onPlaying: @escaping () -> Void,
             onError: @escaping (String) -> Void,
             onAudioTracks: (([(index: Int, name: String)], Int) -> Void)?,
             selectedAudioTrack: Binding<Int>,
             seekTo: Binding<Float>,
             startPosition: Float?,
             isPaused: Binding<Bool>,
             volume: Binding<Float>) {
            self.onProgress = onProgress; self.onDuration = onDuration; self.onFinished = onFinished
            self.onPlaying = onPlaying; self.onError = onError
            self.onAudioTracks = onAudioTracks; self.selectedAudioTrack = selectedAudioTrack
            self.seekTo = seekTo; self.startPosition = startPosition
            self.isPaused = isPaused; self.volume = volume
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

        /// Apply play/pause from the parent's controls.
        func applyPlaybackState(isPaused: Bool) {
            guard let p = player else { return }
            if isPaused {
                if p.state == .playing { p.pause() }
            } else {
                if p.state == .paused { p.play() }
            }
        }

        /// Apply a pending seek from the parent, then clear it (-1).
        func applySeekIfNeeded() {
            guard let p = player, seekTo.wrappedValue >= 0 else { return }
            let target = seekTo.wrappedValue
            p.position = target
            seekTo.wrappedValue = -1
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
            let dur = TimeInterval(p.media?.length.intValue ?? 0) / 1000.0
            if dur > 0 { onDuration(dur) }
            onProgress(p.position, TimeInterval(p.time.intValue) / 1000.0) // VLC time is ms; UI expects seconds
        }
        func mediaPlayerStateChanged(_ aNotification: Notification) {
            guard let p = player else { return }
            switch p.state {
            case .playing:
                onPlaying()
                // VLC ignores position set before playback — apply resume now.
                if !initialSeekDone {
                    initialSeekDone = true
                    if let start = startPosition, start > 0 { p.position = start }
                }
            case .ended: onFinished()
            case .error: onError("VLC couldn't open this stream")
            default: break
            }
        }
    }
}
