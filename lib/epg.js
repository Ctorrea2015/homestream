import fs from "node:fs/promises";
import path from "node:path";

export const EPG_FILE = path.join(process.cwd(), ".data", "epg.json");

export async function readEpg() {
  try {
    return JSON.parse(await fs.readFile(EPG_FILE, "utf8"));
  } catch {
    return { fetchedAt: null, programmes: {}, nameToId: {} };
  }
}

export async function writeEpg(data) {
  const tmp = EPG_FILE + ".tmp";
  await fs.mkdir(path.dirname(EPG_FILE), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, EPG_FILE); // atomic-ish: no half-written guide mid-parse
}

/** XMLTV datetime ("20260105123456 +0100") → epoch ms */
export function xmltvTime(s) {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.(\d+))?\s*([+-]\d{4})?/.exec(s || "");
  if (!m) return NaN;
  const Y = +m[1], Mo = +m[2] - 1, D = +m[3];
  const H = m[4] ? +m[4] : 0, Mi = m[5] ? +m[5] : 0, S = m[6] ? +m[6] : 0;
  const off = m[8]; // m[7] is the optional fraction
  let ms = Date.UTC(Y, Mo, D, H, Mi, S);
  if (off) {
    const mins = (+off.slice(1, 3)) * 60 + (+off.slice(3, 5));
    ms -= (off[0] === "-" ? -1 : 1) * mins * 60000;
  }
  return ms;
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function getElement(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}`, "i").exec(block);
  return m ? decodeEntities(m[1]) : "";
}

function getAttr(block, name) {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(block);
  return m ? m[1] : "";
}

export const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Words that appear in provider channel names but never in guide names.
// Stripping them lets "USA AMC East LHD" fuzzy-match guide key "AMC".
const NOISE = new Set([
  "usa", "uk", "us", "ca", "au", "nz", "fr", "de", "it", "es", "mx", "br", "in", "tr",
  "hd", "uhd", "fhd", "lhd", "sd", "h265", "h264", "hevc", "4k", "8k", "1080p", "720p",
  "east", "west", "north", "south", "eastcoast", "westcoast", "replay",
]);

/** Aggressive channel-name key for fuzzy EPG matching. */
export function fuzzyKey(s) {
  const words = (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w) && !/^\d{5,}/.test(w)); // drop digit blobs too
  return words.join(" ");
}

/** Build { fuzzyKey(name): xmltvId } from a guide's name map. */
export function buildFuzzyIndex(nameToId) {
  const idx = {};
  for (const [display, id] of Object.entries(nameToId)) {
    const k = fuzzyKey(display);
    if (k && !idx[k]) idx[k] = id;
  }
  return idx;
}

/**
 * Resolve a stored channel to its XmlTV programme list.
 * Order: exact tvg-id → exact name → fuzzy name.
 */
export function resolveProgrammes(epg, ch) {
  if (!ch) return null;
  if (ch.tvgId && epg.programmes[ch.tvgId]) return epg.programmes[ch.tvgId];
  const byNorm = ch.name && epg.nameToId[norm(ch.name)];
  if (byNorm && epg.programmes[byNorm]) return epg.programmes[byNorm];
  const fuzzy = epg.fuzzyIndex?.[fuzzyKey(ch.name)];
  if (fuzzy && epg.programmes[fuzzy]) return epg.programmes[fuzzy];
  return null;
}

const TAG_RE = /<programme\b|<channel\b|<\/programme>|<\/channel>/;

/**
 * Streaming XMLTV parser — feeds response chunks and emits concise entries
 * for programmes inside the requested time window. Never holds the full
 * document in memory, which matters: a 22k-channel provider guide can be
 * hundreds of MB.
 */
export function createXmltvParser(windowStart, windowEnd, onProgramme) {
  let buf = "";
  const nameToId = {};
  const rawNames = {}; // original display names, for fuzzy key building

  function handleBlock(tag, block) {
    if (tag === "channel") {
      const id = getAttr(block, "id");
      const name = getElement(block, "display-name");
      if (id && name) {
        nameToId[norm(name)] = id;
        rawNames[name] = id;
      }
      return;
    }
    const chId = getAttr(block, "channel");
    const start = xmltvTime(getAttr(block, "start"));
    const stop = xmltvTime(getAttr(block, "stop"));
    if (!chId || !isFinite(start) || !isFinite(stop)) return;
    if (stop < windowStart || start > windowEnd) return; // outside — skip cheap
    onProgramme({
      id: chId,
      s: start,
      e: stop,
      t: getElement(block, "title").slice(0, 120),
      i: getElement(block, "desc").slice(0, 200),
      g: getElement(block, "category").slice(0, 40),
    });
  }

  return {
    nameToId,
    rawNames,
    feed(chunk) {
      buf += chunk;
      while (true) {
        const m = TAG_RE.exec(buf);
        if (!m) {
          // No full tag in buffer: keep only the last few chars in case a
          // tag name is split across chunk boundary ("<progra|mme")
          if (buf.length > 20) buf = buf.slice(buf.length - 19);
          return;
        }
        const isProgramme = m[0].startsWith("<programme");
        const closeTag = isProgramme ? "</programme>" : "</channel>";
        const closeAt = buf.indexOf(closeTag, m.index);
        if (closeAt === -1) {
          // incomplete block — keep from tag start, wait for more chunks
          buf = buf.slice(m.index);
          return;
        }
        const block = buf.slice(m.index, closeAt + closeTag.length);
        buf = buf.slice(closeAt + closeTag.length);
        handleBlock(isProgramme ? "programme" : "channel", block);
      }
    },
  };
}
