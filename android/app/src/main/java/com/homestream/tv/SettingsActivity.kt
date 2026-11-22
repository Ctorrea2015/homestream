package com.homestream.tv

import android.app.Activity
import android.os.Bundle
import android.widget.*
import kotlin.concurrent.thread

class SettingsActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Settings.init(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(0xFF000000.toInt()); setPadding(32, 32, 32, 32)
        }
        val input = EditText(this).apply { hint = "http://192.168.68.56:3000"; setText(Settings.server) }
        val status = TextView(this).apply { setTextColor(0xFFFFFFFF.toInt()); textSize = 16f; text = "Server URL" }
        root.addView(status); root.addView(input)
        root.addView(Button(this).apply {
            text = "Test & Save"; isFocusable = true
            setOnClickListener {
                Settings.server = input.text.toString().trim().ifBlank { "http://192.168.68.56:3000" }
                status.text = "Testing…"
                thread {
                    val ok = Api.ping()
                    runOnUiThread { status.text = if (ok) "✅ Connected to ${Settings.server}" else "❌ No response — check URL / network" }
                }
            }
        })
        root.addView(Button(this).apply { text = "Done"; setOnClickListener { finish() } })
        setContentView(root)
    }
}
