import fs from "node:fs/promises";
import path from "node:path";

const PROGRESS_FILE = path.join(process.cwd(), ".data", "progress.json");

export async function readProgress() {
  try {
    const raw = await fs.readFile(PROGRESS_FILE, "utf8");
    return JSON.parse(raw); // { items: [ { id, title, poster, type, position, duration, updatedAt } ] }
  } catch {
    return { items: [] };
  }
}

export async function writeProgress(data) {
  await fs.mkdir(path.dirname(PROGRESS_FILE), { recursive: true });
  const tmp = PROGRESS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, PROGRESS_FILE);
}
