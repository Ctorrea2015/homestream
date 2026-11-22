package com.homestream.tv

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.*
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var list: ListView
    private lateinit var title: TextView
    private var meta: List<Meta> = emptyList()
    private var channels: List<Channel> = emptyList()
    private var mode = "movie"

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Settings.init(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(0xFF000000.toInt()) }

        val tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(16, 16, 16, 16) }
        title = TextView(this).apply { text = "HomeStream"; textSize = 20f; setTextColor(0xFFFFFFFF.toInt()); setPadding(16, 8, 0, 8) }
        list = ListView(this).apply { id = android.R.id.list; dividerHeight = 1 }

        fun tab(label: String, action: () -> Unit) = Button(this).apply {
            text = label; isFocusable = true
            setOnClickListener { action() }
        }
        tabs.addView(tab("Movies") { loadCatalog("movie") })
        tabs.addView(tab("Shows") { loadCatalog("series") })
        tabs.addView(tab("Search") { promptSearch() })
        tabs.addView(tab("Live TV") { loadChannels() })
        tabs.addView(tab("Sources") { startActivity(Intent(this@MainActivity, SourcesActivity::class.java)) })
        tabs.addView(tab("Settings") { startActivity(Intent(this@MainActivity, SettingsActivity::class.java)) })

        root.addView(title); root.addView(tabs); root.addView(list, ViewGroup.LayoutParams(-1, -1))
        setContentView(root)

        list.onItemClickListener = AdapterView.OnItemClickListener { _, _, pos, _ ->
            if (mode == "live") {
                val ch = channels.getOrNull(pos) ?: return@OnItemClickListener
                PlayerActivity.open(this, Api.channelUrl(ch.index), ch.name)
            } else {
                val m = meta.getOrNull(pos) ?: return@OnItemClickListener
                thread {
                    val isSeries = m.type == "series"
                    val playable = Api.resolve(if (isSeries) "${m.id}:1:1" else m.id, m.type, if (isSeries) 1 else null, if (isSeries) 1 else null)
                    runOnUiThread {
                        if (playable != null) PlayerActivity.open(this, playable.url, m.name)
                        else Toast.makeText(this, "No source — try again", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
        loadCatalog("movie")
    }

    private fun loadCatalog(type: String) {
        mode = type; title.text = "Loading $type…"; list.adapter = null
        thread {
            meta = Api.catalog(type)
            runOnUiThread {
                title.text = if (type == "movie") "Movies" else "Shows"
                list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, meta.map { it.name })
            }
        }
    }

    private fun loadChannels() {
        mode = "live"; title.text = "Loading channels…"; list.adapter = null
        thread {
            channels = Api.channels()
            runOnUiThread {
                title.text = "Live TV · ${channels.size} channels"
                list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, channels.map { "${it.name}  (${it.group})" })
            }
        }
    }

    private fun promptSearch() {
        val input = EditText(this).apply { hint = "Movie or show title"; isSingleLine = true }
        AlertDialog.Builder(this).setTitle("Search").setView(input)
            .setPositiveButton("Go") { _, _ ->
                val q = input.text.toString().trim()
                if (q.isEmpty()) return@setPositiveButton
                mode = "movie"; title.text = "Searching…"
                thread {
                    meta = Api.search(q)
                    runOnUiThread {
                        title.text = "Results for \"$q\""
                        list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, meta.map { it.name })
                    }
                }
            }.setNegativeButton("Cancel", null).show()
    }
}
