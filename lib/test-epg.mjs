// Unit test: streaming XMLTV parser + time parsing
import { createXmltvParser, xmltvTime, norm } from "./epg.js";

// --- time parsing ---
const cases = [
  ["20260105123456 +0000", Date.UTC(2026, 0, 5, 12, 34, 56)],
  ["20260105123456 +0200", Date.UTC(2026, 0, 5, 10, 34, 56)], // +2 means earlier in UTC
  ["20260105123456 -0500", Date.UTC(2026, 0, 5, 17, 34, 56)],
  ["2026010512 +0000", Date.UTC(2026, 0, 5, 12, 0, 0)],       // date+hour only
  ["", NaN],
];
for (const [input, expected] of cases) {
  const got = xmltvTime(input);
  const ok = (Number.isNaN(expected) && Number.isNaN(got)) || got === expected;
  console.log(ok ? `✓ time  ${input}` : `✗ time  ${input} → ${got} (want ${expected})`);
}
console.log(norm("  CBeebies HD! ") === "cbeebieshd" ? "✓ norm" : "✗ norm");

// --- streaming parser: chunk boundaries slicing a tag mid-word ---
// Programme times must be inside the parser's window (recent), so build
// them relative to "now".
function fmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}
const t0 = Date.now() + 60 * 60000;   // starts in ~1 hour
const t1 = t0 + 3600e3;               // ~1h slot
const t2 = t1 + 3600e3;
const old = Date.now() - 300 * 24 * 3600e3;

const xml = `<tv>
<channel id="news"><display-name>News 24</display-name></channel>
<programme start="${fmt(t0)}" stop="${fmt(t1)}" channel="news"><title>Morning Show</title><desc>All the &amp; news</desc><category>News</category></programme>
<programme start="${fmt(t1)}" stop="${fmt(t2)}" channel="news"><title>Noon Report</title></programme>
<programme start="${fmt(old)}" stop="${fmt(old + 1800e3)}" channel="news"><title>Old programme — outside window</title></programme>
</tv>`;

const got = [];
const names = {};
const parser = createXmltvParser(Date.now() - 2 * 3600e3, Date.now() + 24 * 3600e3, (p) => got.push(p));

// feed 6 bytes at a time to force split tags
for (let i = 0; i < xml.length; i += 6) parser.feed(xml.slice(i, i + 6));

console.log(got.length === 2 ? "✓ window filter (old programme skipped)" : `✗ got ${got.length} programmes`);
const first = got.find((p) => p.t === "Morning Show");
console.log(first && first.i === "All the & news" && first.g === "News" ? "✓ entities + desc/category" : `✗ first: ${JSON.stringify(first)}`);
console.log(parser.nameToId[norm("News 24")] === "news" ? "✓ channel name map" : `✗ nameToId: ${JSON.stringify(parser.nameToId)}`);
console.log(got.every((p) => p.s < p.e) ? "✓ times ordered" : "✗ bad times");
