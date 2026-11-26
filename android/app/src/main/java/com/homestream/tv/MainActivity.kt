package com.homestream.tv

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.view.ViewGroup
import android.widget.*
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var scroll: ScrollView
    private lateinit var container: LinearLayout
    private lateinit var nav: LinearLayout
    private var channels: List<Channel> = emptyList()

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Settings.init(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // browsing won't trigger screensaver either
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(0xFF0B0B0F.toInt()) }

        val brand = TextView(this).apply {
            text = "HOME▸STREAM"; textSize = 22f; setTypeface(null, Typeface.BOLD)
            setTextColor(0xFFE50914.toInt()); setPadding(24, 18, 0, 6)
        }
        nav = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(16, 4, 16, 8) }
        fun tab(label: String, action: () -> Unit) = Button(this).apply {
            text = label; isFocusable = true; textSize = 14f
            setTextColor(0xFFFFFFFF.toInt()); background = null
            setPadding(18, 10, 18, 10)
            setOnFocusChangeListener { _, f -> setTypeface(null, if (f) Typeface.BOLD else Typeface.NORMAL)
                setTextColor(if (f) 0xFFE50914.toInt() else 0xFFFFFFFF.toInt()) }
            setOnClickListener { action() }
        }
        nav.addView(tab("● Movies") { loadCatalog("movie") })
        nav.addView(tab("Shows") { loadCatalog("series") })
        nav.addView(tab("Search") { promptSearch() })
        nav.addView(tab("Live TV") { loadChannels() })
        nav.addView(tab("Find Channel") { promptChannelSearch() })
        nav.addView(tab("Sources") { startActivity(Intent(this, SourcesActivity::class.java)) })
        nav.addView(tab("Settings") { startActivity(Intent(this, SettingsActivity::class.java)) })

        scroll = ScrollView(this)
        container = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, 40) }
        scroll.addView(container, ViewGroup.LayoutParams(-1, -1))
        root.addView(brand); root.addView(nav); root.addView(scroll, ViewGroup.LayoutParams(-1, -1))
        setContentView(root)
        loadCatalog("movie")
    }

    private fun clearRows() {
        container.removeAllViews()
        val loading = TextView(this).apply { text = "Loading…"; setTextColor(Color.WHITE); setPadding(24, 40, 0, 0) }
        container.addView(loading)
    }

    private fun loadCatalog(type: String) {
        clearRows()
        thread {
            val items = Api.catalog(type)
            runOnUiThread {
                container.removeAllViews()
                if (items.isEmpty()) { empty("No titles loaded — check the server URL in Settings"); return@runOnUiThread }
                val row = PosterRow(this, if (type == "movie") "POPULAR MOVIES" else "POPULAR SHOWS")
                items.take(60).forEach { m ->
                    row.add(m) {
                        val isSeries = m.type == "series"
                        thread {
                            val playable = Api.resolve(if (isSeries) "${m.id}:1:1" else m.id, m.type,
                                if (isSeries) 1 else null, if (isSeries) 1 else null)
                            runOnUiThread {
                                if (playable != null) PlayerActivity.open(this, playable.url, m.name)
                                else Toast.makeText(this, "No source — try again", Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                }
                container.addView(row)
            }
        }
    }

    private fun loadChannels() {
        clearRows()
        thread {
            channels = Api.channels()
            runOnUiThread {
                container.removeAllViews()
                if (channels.isEmpty()) { empty("No channels — add a source in Sources"); return@runOnUiThread }
                // Group by category, each as a poster row with channel logos.
                val groups = channels.groupBy { it.group.ifBlank { "Other" } }
                for ((name, list) in groups) {
                    if (list.isEmpty()) continue
                    val row = PosterRow(this, name.uppercase())
                    list.take(80).forEach { ch ->
                        val m = Meta(ch.index.toString(), ch.name, "live", ch.logo?.ifBlank { null })
                        row.add(m) { PlayerActivity.open(this, Api.channelUrl(ch.index), ch.name) }
                    }
                    container.addView(row)
                }
            }
        }
    }

    private fun promptChannelSearch() {
        if (channels.isEmpty()) {
            Toast.makeText(this, "Loading channels first…", Toast.LENGTH_SHORT).show()
            thread { channels = Api.channels() }
        }
        val input = EditText(this).apply { hint = "Channel name or category"; isSingleLine = true }
        AlertDialog.Builder(this).setTitle("Find a channel").setView(input)
            .setPositiveButton("Search") { _, _ ->
                val q = input.text.toString().trim().lowercase()
                if (q.isEmpty()) return@setPositiveButton
                container.removeAllViews()
                val found = channels.filter { it.name.lowercase().contains(q) || (it.group ?: "").lowercase().contains(q) }
                if (found.isEmpty()) { empty("No channels match \"$q\""); return@setPositiveButton }
                val row = PosterRow(this, "${found.size} CHANNELS MATCHING \"${q.uppercase()}\"")
                found.take(300).forEach { ch ->
                    val m = Meta(ch.index.toString(), ch.name, "live", ch.logo?.ifBlank { null })
                    row.add(m) { PlayerActivity.open(this, Api.channelUrl(ch.index), ch.name) }
                }
                container.addView(row)
            }.setNegativeButton("Cancel", null).show()
    }

    private fun empty(msg: String) {
        container.addView(TextView(this).apply {
            text = msg; setTextColor(0xFFAAAAAA.toInt()); textSize = 18f; setPadding(24, 40, 24, 0)
        })
    }

    private fun promptSearch() {
        val input = EditText(this).apply { hint = "Movie or show title"; isSingleLine = true }
        AlertDialog.Builder(this).setTitle("Search").setView(input)
            .setPositiveButton("Go") { _, _ ->
                val q = input.text.toString().trim()
                if (q.isEmpty()) return@setPositiveButton
                clearRows()
                thread {
                    val found = Api.search(q)
                    runOnUiThread {
                        container.removeAllViews()
                        if (found.isEmpty()) { empty("No results for \"$q\""); return@runOnUiThread }
                        val row = PosterRow(this, "RESULTS FOR \"${q.uppercase()}\"")
                        found.forEach { m -> row.add(m) {
                            thread {
                                val isSeries = m.type == "series"
                                val p = Api.resolve(if (isSeries) "${m.id}:1:1" else m.id, m.type,
                                    if (isSeries) 1 else null, if (isSeries) 1 else null)
                                runOnUiThread { if (p != null) PlayerActivity.open(this, p.url, m.name)
                                    else Toast.makeText(this, "No source", Toast.LENGTH_SHORT).show() }
                            }
                        } }
                        container.addView(row)
                    }
                }
            }.setNegativeButton("Cancel", null).show()
    }
}
