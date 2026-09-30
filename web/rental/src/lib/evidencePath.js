/*
 * evidencePath.js — pure helpers for the evidence archive: which folder
 * layout the user connected, and whether an evidence_path from the
 * bundle is safe to walk. Node-tested; store.js does the actual walking.
 */

export const EXPORT_DIR = 'export';
export const EVIDENCE_DIR = 'evidence';

/**
 * Decide what the connected folder is from its top-level entry names.
 *   'parent' — the RentalDashboard folder: has export/ (and, usually,
 *              evidence/). Bundle from export/, evidence openable.
 *   'export' — the export folder itself: manifest.json at top level.
 *              Bundle readable, evidence not reachable (no parent access).
 * @param {{dirs: Iterable<string>, files: Iterable<string>}} names
 * @returns {{layout:'parent'|'export', evidence:boolean}}
 */
export function detectLayout({ dirs, files }) {
  const d = new Set(dirs), f = new Set(files);
  if (d.has(EXPORT_DIR)) return { layout: 'parent', evidence: d.has(EVIDENCE_DIR) };
  if (f.has('manifest.json')) return { layout: 'export', evidence: false };
  throw new Error('Not the RentalDashboard folder: expected an export\\ subfolder (or manifest.json). Pick Dropbox → RRG Shared → Apps → RentalDashboard.');
}

/**
 * Split a bundle evidence_path ('evidence/2026-09-14/kijiji/1.html') into
 * directory segments + file name, refusing anything that could walk out
 * of the archive. The path came from a CSV on disk, so it is data.
 * @returns {{dirs:string[], file:string}|null} null when unusable
 */
export function evidenceSegments(path) {
  if (typeof path !== 'string' || !path) return null;
  const parts = path.split('/');
  if (parts.length < 2 || parts[0] !== EVIDENCE_DIR) return null;
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes(':')) return null;
  }
  const file = parts[parts.length - 1];
  if (!/\.html?$/i.test(file)) return null;
  return { dirs: parts.slice(0, -1), file };
}
