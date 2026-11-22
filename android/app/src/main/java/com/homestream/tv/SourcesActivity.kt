package com.homestream.tv

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.view.ViewGroup
import android.widget.*
import kotlin.concurrent.thread

class SourcesActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Settings.init(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(0xFF000000.toInt()); setPadding(32, 32, 32, 32)
        }
        val status = TextView(this).apply { text = "Add your channels"; setTextColor(0xFFFFFFFF.toInt()); textSize = 18f }

        val url = EditText(this).apply { hint = "M3U playlist URL" }
        val paste = EditText(this).apply { hint = "Or paste M3U contents"; singleLine = false }
        val host = EditText(this).apply { hint = "Xtream host (http://...)" }
        val user = EditText(this).apply { hint = "Xtream username" }
        val pass = EditText(this).apply { hint = "Xtream password" }

        fun button(label: String, action: () -> Unit) = Button(this).apply {
            text = label; isFocusable = true; setOnClickListener { action() }
        }
        root.addView(status)
        root.addView(url); root.addView(button("Add M3U URL") { run(status, "Adding…") { Api.addM3uUrl(url.text.toString()) } })
        root.addView(paste); root.addView(button("Import pasted M3U") { run(status, "Importing…") { Api.importM3u(paste.text.toString()) } })
        root.addView(host); root.addView(user); root.addView(pass)
        root.addView(button("Save & sync Xtream") { run(status, "Syncing…") { Api.addXtream(host.text.toString(), user.text.toString(), pass.text.toString()) } })
        root.addView(button("Done") { finish() })
        setContentView(root)
    }

    private fun run(status: TextView, busy: String, work: () -> String) {
        status.text = busy
        thread { val r = work(); runOnUiThread { status.text = r; Toast.makeText(this, r, Toast.LENGTH_LONG).show() } }
    }
}
