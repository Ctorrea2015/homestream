package com.homestream.tv

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

object Settings {
    private const val PREF = "hs"
    private lateinit var prefs: SharedPreferences

    fun init(ctx: Context) { prefs = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE) }

    var server: String
        get() = prefs.getString("server", "http://192.168.68.56:3000") ?: "http://192.168.68.56:3000"
        set(v) = prefs.edit().putString("server", v).apply()

    fun encoded(s: String) = URLEncoder.encode(s, "UTF-8") ?: s
}

data class Meta(val id: String, val name: String, val type: String, val poster: String?)
data class Channel(val index: Int, val name: String, val group: String, val logo: String?)
data class Playable(val url: String, val title: String)

object Api {
    private fun get(path: String, timeout: Int = 25000): String {
        val c = URL("${Settings.server}$path").openConnection() as HttpURLConnection
        c.connectTimeout = timeout; c.readTimeout = timeout
        c.requestMethod = "GET"
        c.setRequestProperty("User-Agent", "HomeStreamTV/1.0")
        return try {
            c.inputStream.bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }

    private fun post(path: String, json: String): Pair<Int, String> {
        val c = URL("${Settings.server}$path").openConnection() as HttpURLConnection
        c.connectTimeout = 20000; c.readTimeout = 40000
        c.requestMethod = "POST"; c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        return try {
            c.outputStream.use { it.write(json.toByteArray()) }
            val code = c.responseCode
            val body = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            code to body
        } finally { c.disconnect() }
    }

    fun ping(): Boolean = try { JSONObject(get("/api/rqbit/health")); true } catch (e: Exception) { false }

    fun catalog(type: String): List<Meta> = try {
        val c = URL("https://v3-cinemeta.strem.io/catalog/$type/top.json").openConnection() as HttpURLConnection
        c.connectTimeout = 20000; c.readTimeout = 20000
        val arr = JSONObject(c.inputStream.bufferedReader().use { it.readText() }).optJSONArray("metas") ?: JSONArray()
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.getJSONObject(i)
            Meta(o.optString("id"), o.optString("name"), o.optString("type", type), o.optString("poster").ifBlank { null })
        }
    } catch (e: Exception) { emptyList() }

    fun search(query: String): List<Meta> {
        val found = mutableListOf<Meta>()
        val seen = HashSet<String>()
        // Search BOTH movie and series catalogs — TV shows never appeared
        // when only the movie catalog was queried.
        for (type in listOf("movie", "series")) {
            try {
                val url = "https://v3-cinemeta.strem.io/catalog/$type/top/search=${Settings.encoded(query)}.json"
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 20000; c.readTimeout = 20000
                val arr = JSONObject(c.inputStream.bufferedReader().use { it.readText() }).optJSONArray("metas") ?: JSONArray()
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val id = o.optString("id")
                    if (id.isEmpty() || !seen.add(id)) continue
                    found.add(Meta(id, o.optString("name"), o.optString("type", type), o.optString("poster").ifBlank { null }))
                }
            } catch (_: Exception) {}
        }
        return found
    }

    /** One-tap resolve — same as the iPhone app: pre-warmed source, Riptide. */
    fun resolve(id: String, type: String, season: Int?, episode: Int?): Playable? = try {
        var path = "/api/torrent/resolve?id=${Settings.encoded(id)}&type=$type"
        if (season != null) path += "&s=$season"
        if (episode != null) path += "&e=$episode"
        val o = JSONObject(get(path, 90000))
        if (o.optBoolean("ok")) Playable(o.optString("streamUrl"), o.optString("title")) else null
    } catch (e: Exception) { null }

    fun channels(): List<Channel> = try {
        val arr = JSONObject(get("/api/tv")).optJSONArray("channels") ?: JSONArray()
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.getJSONObject(i)
            Channel(i, o.optString("name"), o.optString("group"), o.optString("logo"))
        }
    } catch (e: Exception) { emptyList() }

    fun channelUrl(index: Int) = "${Settings.server}/api/iptv/m3u/play?index=$index"

    fun importM3u(text: String): String {
        val (code, body) = post("/api/tv/import-text", JSONObject().put("text", text).toString())
        return if (code == 200) "Imported: ${JSONObject(body).optInt("added")} channels" else "Failed: ${JSONObject(body).optString("error")}"
    }

    fun addM3uUrl(url: String): String {
        val (code, body) = post("/api/tv", JSONObject().put("source", url).toString())
        return if (code == 200) "Added: ${JSONObject(body).optInt("added")} channels" else "Failed: ${JSONObject(body).optString("error")}"
    }

    fun addXtream(host: String, user: String, pass: String): String {
        val (code, body) = post("/api/settings/iptv", JSONObject()
            .put("host", host).put("username", user).put("password", pass).toString())
        return if (code == 200) "Saved + synced" else "Failed: ${JSONObject(body).optString("error")}"
    }
}
