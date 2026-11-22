package com.homestream.tv

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.widget.MediaController
import android.widget.VideoView
import java.net.URLEncoder

/** Fallback player for devices where LibVLC can't initialize: uses Android's
 * built-in VideoView to play HomeStream's server-converted HLS stream. */
class FallbackPlayerActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Settings.init(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val video = VideoView(this)
        setContentView(video)
        val enc = URLEncoder.encode(PlayerActivity.currentUrl, "UTF-8")
        val url = "${Settings.server}/api/tv/transcode?u=$enc&f=hls&vod=1"
        video.setVideoURI(Uri.parse(url))
        video.setMediaController(MediaController(this).apply { setAnchorView(video) })
        video.requestFocus()
        video.start()
    }
}
