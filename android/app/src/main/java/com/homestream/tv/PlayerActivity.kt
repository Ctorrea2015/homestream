package com.homestream.tv

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout

class PlayerActivity : Activity() {
    private var libvlc: LibVLC? = null
    private var player: MediaPlayer? = null
    private lateinit var controls: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val hide = Runnable { controls.visibility = View.GONE }
    private var destroyed = false
    private var checkPlay: Runnable? = null

    companion object {
        private var pendingUrl = ""
        private var pendingTitle = ""
        fun open(activity: Activity, url: String, title: String) {
            pendingUrl = url; pendingTitle = title
            activity.startActivity(android.content.Intent(activity, PlayerActivity::class.java))
        }
    }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // no screensaver mid-movie
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        val video = VLCVideoLayout(this)
        root.addView(video, FrameLayout.LayoutParams(-1, -1))
        controls = TextView(this).apply {
            text = "$pendingTitle\n\nOK  play / pause      ◀ ▶  seek 10s      BACK  exit"
            setTextColor(0xFFFFFFFF.toInt()); textSize = 20f
            setPadding(32, 24, 32, 32); gravity = Gravity.BOTTOM or Gravity.LEFT
            setBackgroundColor(0x99000000.toInt())
        }
        root.addView(controls, FrameLayout.LayoutParams(-1, -1))
        val spinner = ProgressBar(this).apply { isIndeterminate = true }
        root.addView(spinner, FrameLayout.LayoutParams(80, 80, Gravity.CENTER))
        val hint = TextView(this).apply {
            text = "Connecting to stream…"; setTextColor(0xFFCCCCCC.toInt()); textSize = 14f
            gravity = Gravity.CENTER
        }
        root.addView(hint, FrameLayout.LayoutParams(-1, -1, Gravity.BOTTOM or Gravity.CENTER))
        setContentView(root)

        try {
            libvlc = LibVLC(this, arrayListOf(
                "--no-video-title-show",
                "--network-caching=3000",
                "--http-timeout=120",        // patient with cold torrent starts (was ~31s to first byte)
                "--file-caching=2000",
                "--drop-late-frames",
                "--skip-frames"
            ))
            player = MediaPlayer(libvlc).apply {
                attachViews(video, null, false, false)
                val m = Media(libvlc, android.net.Uri.parse(pendingUrl))
                media = m; m.release()
                play()
            }
            spinner.visibility = View.VISIBLE   // hide once video starts (on first frame)
            hint.visibility = View.VISIBLE
            showControls()
            // Hide the loading overlay once media actually starts playing.
            val check = object : Runnable {
                override fun run() {
                    if (destroyed) return
                    if (player?.isPlaying == true) { spinner.visibility = View.GONE; hint.visibility = View.GONE }
                    else handler.postDelayed(this, 500)
                }
            }
            checkPlay = check
            handler.post(check)
        } catch (e: Exception) {
            Toast.makeText(this, "Player error: ${e.message}", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    private fun showControls() {
        controls.visibility = View.VISIBLE
        handler.removeCallbacks(hide)
        handler.postDelayed(hide, 4000)   // auto-hide like the iPhone app
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                player?.let { if (it.isPlaying) it.pause() else it.play() }
                showControls(); return true
            }
            KeyEvent.KEYCODE_DPAD_LEFT -> { player?.let { it.time = (it.time - 10000).coerceAtLeast(0) }; showControls(); return true }
            KeyEvent.KEYCODE_DPAD_RIGHT -> { player?.let { it.time += 10000 }; showControls(); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        destroyed = true
        handler.removeCallbacks(hide)
        checkPlay?.let { handler.removeCallbacks(it) }
        player?.let { it.detachViews(); it.release() }
        libvlc?.release()
        super.onDestroy()
    }
}
