// Tries several channels through the proxy until one plays end-to-end.
const PROXY = "http://localhost:3000/api/tv/play";

async function j(url) {
  const full = new URL(url, PROXY).href;
  const r = await fetch(full);
  return { status: r.status, type: r.headers.get("content-type"), text: await r.text() };
}

const { channels } = await (await fetch("http://localhost:3000/api/tv")).json();
const m3u8s = channels.filter((c) => /\.m3u8/i.test(c.url)).slice(0, 80);

for (const ch of m3u8s) {
  const master = await j(PROXY + "?u=" + encodeURIComponent(ch.url));
  if (master.status !== 200) { console.log(`✗ ${ch.name}: master ${master.status} ${master.text.slice(0, 60)}`); continue; }
  const lines = master.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const variantLine = lines.find((l) => !l.startsWith("#"));
  if (!variantLine) { console.log(`✗ ${ch.name}: master has no variant URL`); continue; }
  const v = await j(variantLine);
  if (v.status !== 200) { console.log(`✗ ${ch.name}: variant ${v.status} ${v.text.slice(0, 50)}`); continue; }
  const vLines = v.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const seg = vLines.filter((l) => !l.startsWith("#")).pop();
  if (!seg) { console.log(`✗ ${ch.name}: variant has no segments (${v.text.slice(0, 80).replace(/\n/g, " ")})`); continue; }
  const r = await fetch(new URL(seg, PROXY).href);
  const buf = await r.arrayBuffer();
  const head = Array.from(new Uint8Array(buf.slice(0, 4))).join(",");
  const isTs = head === "71,80,79,158";
  console.log(`✓ ${ch.name} — segment ${(buf.byteLength / 1024).toFixed(0)} KB, TS=${isTs}, ext=${ch.url.slice(-20)}`);
  break;
}
