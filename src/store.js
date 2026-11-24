// Tiny JSON file storage for the config (API key, channel) and the tracker's saved progress.
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`  (Could not read ${path.basename(file)}: ${e.message}. Starting fresh.)`);
    return fallback;
  }
}

// Write to a temp file first and then swap it in, so a crash mid-write can't leave a broken file.
export function writeJson(file, data, { pretty = false } = {}) {
  const text = JSON.stringify(data, null, pretty ? 2 : 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    try { fs.writeFileSync(file, text); } catch (e) { console.warn(`  (Could not save ${path.basename(file)}: ${e.message})`); }
  }
}
