/**
 * Xtream Codes provider login helpers.
 *
 * Almost every commercial IPTV provider runs an "Xtream Codes" API:
 * login = server host + username + password, and everything else
 * (channels, logos, categories, EPG) is derived from it.
 */

export function xtreamError(message, status = 400) {
  return { error: message, status };
}

export function normalizeHost(input) {
  let s = (input || "").trim();
  if (!s) return null;
  // Accept "myprovider.tv:8080", "http://myprovider.tv:8080/", "https://myprovider.tv"
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function xtreamUrls(host, username, password) {
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  return {
    // account/status + stream lists live here
    api: `${host}/player_api.php?username=${user}&password=${pass}`,
    // full playlist (m3u_plus = with tvg-logo / group-title metadata)
    playlist: `${host}/get.php?username=${user}&password=${pass}&type=m3u_plus`,
    // XMLTV guide, useful for the future EPG feature
    epg: `${host}/xmltv.php?username=${user}&password=${pass}`,
  };
}

/**
 * Connects to an Xtream provider and returns the playlist text.
 * Throws Error with a user-facing message on any failure.
 */
export async function xtreamConnect(host, username, password) {
  const { api, playlist } = xtreamUrls(host, username, password);

  let res;
  try {
    res = await fetch(api, {
      headers: { "User-Agent": "HomeStream/1.0 VLC/3.0" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`Couldn't reach ${host} — check the server address. (${err?.cause?.code || err?.message || "network error"})`);
  }
  if (!res.ok) {
    throw new Error(`Provider returned HTTP ${res.status} — is the address/port right?`);
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error("That server answered, but not with Xtream API data — is it really an IPTV/login server?");
  }

  const ui = payload?.user_info;
  if (!ui || ui.auth !== 1) {
    throw new Error(`Login rejected (${ui?.status || "Invalid credentials"}) — check the username and password (and note the server may be case-sensitive).`);
  }

  const plRes = await fetch(playlist, {
    headers: { "User-Agent": "HomeStream/1.0 VLC/3.0" },
    signal: AbortSignal.timeout(60000),
  });
  if (!plRes.ok) {
    // Some providers disable get.php; try the standard variant
    const altRes = await fetch(playlist.replace("type=m3u_plus", "type=m3u&output=ts"), {
      headers: { "User-Agent": "HomeStream/1.0 VLC/3.0" },
      signal: AbortSignal.timeout(60000),
    });
    if (!altRes.ok) throw new Error(`Logged in, but playlist download failed (HTTP ${plRes.status}).`);
    return { text: await altRes.text(), epg: xtreamUrls(host, username, password).epg };
  }
  return { text: await plRes.text(), epg: xtreamUrls(host, username, password).epg };
}
