/*
 * flyerPath.js — pure helpers for the connected folder: which layout the
 * user picked, and whether a flyer_path from the bundle is safe to walk.
 * Node-tested; store.js does the actual walking.
 */

export const EXPORT_DIR = 'export';
export const FLYERS_DIR = 'flyers';
export const SNAPSHOTS_DIR = 'moodys';

/**
 * Decide what the connected folder is from its top-level entry names.
 *   'parent' — the published folder: has export/ (and, when the publish
 *              included them, flyers/). Bundle from export/, flyers
 *              openable.
 *   'export' — the export folder itself: manifest.json at top level.
 *              Bundle readable, flyers not reachable — a directory handle
 *              cannot see its parent, which is why the panel asks for the
 *              folder ABOVE export.
 * @param {{dirs: Iterable<string>, files: Iterable<string>}} names
 * @returns {{layout:'parent'|'export', flyers:boolean}}
 */
export function detectLayout({ dirs, files }) {
  const d = new Set(dirs), f = new Set(files);
  if (d.has(EXPORT_DIR)) return { layout: 'parent', flyers: d.has(FLYERS_DIR) };
  if (f.has('manifest.json')) return { layout: 'export', flyers: false };
  throw new Error('That folder has no export\\ subfolder (or manifest.json). Pick the shared AppMarketData folder or its CommercialAvailability subfolder.');
}

/**
 * Split a bundle flyer_path ('flyers/Avison Young/x_20260705.pdf') into
 * directory segments + file name, refusing anything that could walk out
 * of the flyer tree. The path came from a CSV on disk, so it is data.
 * @returns {{dirs:string[], file:string}|null} null when unusable
 */
export function flyerSegments(path) {
  if (typeof path !== 'string' || !path) return null;
  const parts = path.split('/');
  if (parts.length < 2 || parts[0] !== FLYERS_DIR) return null;
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.includes('\\') || p.includes(':')) return null;
  }
  const file = parts[parts.length - 1];
  if (!/\.pdf$/i.test(file)) return null;
  return { dirs: parts.slice(0, -1), file };
}

/**
 * A Moody's snapshot path as segments, or null.
 *
 *   moodys/{id}.jpg                          the current capture
 *   moodys/{id}_listed.jpg                   frozen when first seen
 *   moodys/{id}_conditional.jpg              frozen when it went conditional
 *   moodys/{id}_email-new-YYYYMMDD.jpg       the alert email's card
 *   moodys/{id}_email-pending-YYYYMMDD.jpg
 *
 * Exactly those shapes and nothing else — no subfolder, no other
 * extension, no '..' — because the path is data from a CSV in a shared
 * folder, and export_web only ever writes these.
 * @returns {{dirs:string[], file:string}|null}
 */
const SNAPSHOT_FILE = /^moodys\/([a-f0-9]{16,40}(?:_(?:listed|conditional|email-(?:new|pending)-\d{8}))?\.jpg)$/;
export function snapshotSegments(path) {
  const m = typeof path === 'string' && path.match(SNAPSHOT_FILE);
  return m ? { dirs: [SNAPSHOTS_DIR], file: m[1] } : null;
}

/**
 * Every snapshot a record has, in the order it happened, with the label
 * the picker shows: [{ path, label }]. The current capture comes last —
 * it is "now", after the whole history.
 */
export function snapshotsOf(r) {
  const out = [];
  for (const path of String(r?.moodys_snapshots ?? '').split(';').filter(Boolean)) {
    if (!snapshotSegments(path)) continue;
    const m = path.match(/_(listed|conditional|email-(new|pending)-(\d{4})(\d{2})(\d{2}))\.jpg$/);
    if (!m) continue;
    const label = m[1] === 'listed' ? 'Listed'
      : m[1] === 'conditional' ? 'Conditional'
        : `${m[2] === 'new' ? 'New' : 'Pending'} (email ${m[3]}-${m[4]}-${m[5]})`;
    out.push({ path, label });
  }
  if (snapshotSegments(r?.moodys_snapshot_path)) {
    out.push({ path: r.moodys_snapshot_path, label: 'Current' });
  }
  return out;
}
