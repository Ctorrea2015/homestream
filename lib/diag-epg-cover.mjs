import { readIptv } from "./iptv.js";
import { readEpg, norm } from "./epg.js";

const epg = await readEpg();
const iptv = await readIptv();

console.log("guide loaded:", !!epg.fetchedAt, "| epg channels with data:", Object.keys(epg.programmes).length);

let withTvgId = 0, matchedByName = 0, unmatched = 0, notFromEpgSource = 0;
for (const c of iptv.channels) {
  if (c.tvgId && epg.programmes[c.tvgId]) { withTvgId++; continue; }
  if (c.name && epg.nameToId[norm(c.name)] && epg.programmes[epg.nameToId[norm(c.name)]]) matchedByName++;
  else if (c.source?.startsWith("xtream")) unmatched++;
  else notFromEpgSource++;
}
console.log("channels matched via tvg-id:", withTvgId);
console.log("channels matched via name:", matchedByName);
console.log("provider channels with NO guide match:", unmatched);
console.log("non-provider channels (expected no guide):", notFromEpgSource);

// sample a few unmatched provider channels to see the pattern
const samples = iptv.channels.filter((c) => c.source?.startsWith("xtream")).filter((c) => !(c.name && epg.nameToId[norm(c.name)]) && !(c.tvgId && epg.programmes[c.tvgId])).slice(0, 8);
console.log("\nsample unmatched:", samples.map((c) => c.name));
console.log("\nsample guide channel ids:", Object.keys(epg.programmes).slice(0, 10));
