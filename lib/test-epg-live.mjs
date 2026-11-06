import { readEpg } from "./epg.js";
import { readIptv } from "./iptv.js";
import { norm } from "./epg.js";

const epg = await readEpg();
const iptv = await readIptv();
const top = Object.entries(epg.programmes)
  .map(([id, list]) => [id, list.length])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3);

for (const [id, n] of top) {
  const ch =
    iptv.channels.find((c) => c.tvgId === id) ||
    iptv.channels.find((c) => c.name && epg.nameToId[norm(c.name)] === id);
  if (!ch) { console.log("(no matching channel for epg id", id + ")"); continue; }
  const res = await fetch("http://localhost:3000/api/tv/epg?u=" + encodeURIComponent(ch.url));
  const out = await res.json();
  const hhmm = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  console.log("— " + ch.name + "  (EPG entries: " + n + ")");
  console.log("   now:  " + (out.now ? out.now.t + " (" + hhmm(out.now.s) + "–" + hhmm(out.now.e) + ")" : "none"));
  console.log("   next: " + (out.next || []).slice(0, 3).map((x) => hhmm(x.s) + " " + x.t).join(" | "));
}
