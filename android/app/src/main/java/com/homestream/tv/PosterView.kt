package com.homestream.tv

import android.app.Activity
import android.content.Intent
import android.graphics.*
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.text.TextUtils
import android.view.*
import android.widget.*
import kotlin.concurrent.thread

/** A poster card: artwork (or a generated gradient) + title + focus glow. */
class PosterView(ctx: android.content.Context) : ViewGroup(ctx) {
    private val img = ImageView(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
    private val shade = View(ctx)
    private val label = TextView(ctx).apply {
        textSize = 15f; setTextColor(Color.WHITE); maxLines = 2; ellipsize = TextUtils.TruncateAt.END
        setShadowLayer(6f, 0f, 2f, Color.BLACK); gravity = Gravity.BOTTOM or Gravity.LEFT
        setPadding(10, 6, 10, 10)
    }
    var meta: Meta? = null
    var onClick: (() -> Unit)? = null
    private val W = 190
    private val H = 285

    init {
        addView(img, LayoutParams(W, H)); addView(shade, LayoutParams(W, H)); addView(label, LayoutParams(W, H))
        isFocusable = true
        setOnClickListener { onClick?.invoke() }
        setOnFocusChangeListener { _, has -> scaleX = if (has) 1.08f else 1f; scaleY = if (has) 1.08f else 1f
            shade.setBackgroundColor(if (has) 0x33E50914 else 0x00000000); invalidate() }
        // Dark gradient fallback when no poster is available.
        img.setImageDrawable(gradient(meta?.name ?: "HomeStream"))
    }

    fun bind(m: Meta) {
        meta = m; label.text = m.name
        img.setImageDrawable(gradient(m.name))
        if (!m.poster.isNullOrBlank()) thread {
            try {
                val bmp = apiBitmap(m.poster!!)
                post { img.setImageBitmap(bmp) }
            } catch (_: Exception) {}
        }
    }

    private fun apiBitmap(url: String): Bitmap {
        val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        c.connectTimeout = 8000; c.readTimeout = 8000
        c.inputStream.use { return BitmapFactory.decodeStream(it) }
    }

    private fun gradient(seed: String): Drawable {
        val hues = intArrayOf(0xFF3D2F8F.toInt(), 0xFF123A5E.toInt(), 0xFF4A2E13.toInt(), 0xFF0F4A3D.toInt(), 0xFF401042.toInt())
        val c = hues[(seed.hashCode() and 0x7fffffff) % hues.size]
        return android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TL_BR,
            intArrayOf(c, Color.rgb((Color.red(c) / 2), (Color.green(c) / 2), (Color.blue(c) / 2))))
    }

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(W + 16, H + 16)
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        img.layout(8, 8, 8 + W, 8 + H); shade.layout(8, 8, 8 + W, 8 + H); label.layout(8, 8, 8 + W, 8 + H)
    }
}

/** Horizontally scrolling row of posters with a header. */
class PosterRow(ctx: Activity, title: String) : LinearLayout(ctx) {
    val strip = HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false }
    private val inner = LinearLayout(ctx).apply { orientation = HORIZONTAL; setPadding(20, 4, 20, 20) }
    init {
        orientation = VERTICAL
        val header = TextView(ctx).apply { text = title; textSize = 17f; setTextColor(0xFFE50914.toInt()); setPadding(24, 18, 0, 6); setTypeface(null, Typeface.BOLD) }
        addView(header); strip.addView(inner); addView(strip)
    }
    fun add(meta: Meta, click: () -> Unit) {
        val v = PosterView(context).apply { bind(meta); onClick = click }
        inner.addView(v)
    }
    fun clear() = inner.removeAllViews()
}
