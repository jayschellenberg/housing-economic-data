/*
 * Folder-layout detection and flyer-path safety. A flyer_path comes from
 * a CSV on disk, so it is data: it must not be able to walk out of the
 * flyer tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectLayout, flyerSegments } from '../src/lib/flyerPath.js';

test('the published folder is the parent layout', () => {
  assert.deepEqual(
    detectLayout({ dirs: ['export', 'flyers'], files: ['current_master.xlsx'] }),
    { layout: 'parent', flyers: true },
  );
});

test('a publish without flyers still connects', () => {
  assert.deepEqual(detectLayout({ dirs: ['export'], files: [] }),
    { layout: 'parent', flyers: false });
});

test('picking export/ itself works but forfeits flyers', () => {
  // A directory handle cannot reach its parent, so there is no way back
  // up to flyers/ — the panel says so rather than silently hiding them.
  assert.deepEqual(detectLayout({ dirs: [], files: ['manifest.json', 'records.csv'] }),
    { layout: 'export', flyers: false });
});

test('an unrelated folder is refused with a message that says what to pick', () => {
  assert.throws(() => detectLayout({ dirs: ['Documents'], files: ['notes.txt'] }),
    /CommercialAvailability/);
});

test('a flyer path splits into directories and a file', () => {
  assert.deepEqual(flyerSegments('flyers/Avison Young/1015-kapelus-drive_20260705.pdf'),
    { dirs: ['flyers', 'Avison Young'], file: '1015-kapelus-drive_20260705.pdf' });
});

test('traversal, absolute paths and non-PDFs are refused', () => {
  for (const bad of [
    'flyers/../../secrets/apikey.txt',
    'flyers/../apikey.txt',
    'flyers/CBRE/../../x.pdf',
    'C:/flyers/CBRE/x.pdf',
    'flyers/CBRE\\x.pdf',
    'export/records.csv',
    'flyers/CBRE/x.exe',
    'flyers//x.pdf',
    'flyers',
    '',
    null,
    42,
  ]) {
    assert.equal(flyerSegments(bad), null, String(bad));
  }
});

// ---------- Moody's screenshots ----------

import { snapshotSegments, SNAPSHOTS_DIR } from '../src/lib/flyerPath.js';

test('a snapshot path is exactly the one shape export_web writes', () => {
  assert.deepEqual(snapshotSegments('moodys/6a2c5e15632a957e4bd75012.jpg'),
    { dirs: [SNAPSHOTS_DIR], file: '6a2c5e15632a957e4bd75012.jpg' });
});

test('nothing else reaches the folder handle', () => {
  /* The path is data from a CSV in a shared folder. It is stricter than a
     flyer path because it can be: one directory, a hex id, one extension. */
  for (const bad of [
    'moodys/../export/manifest.json', 'moodys/sub/6a2c5e15632a957e4bd75012.jpg',
    'moodys/6a2c5e15632a957e4bd75012.png', 'moodys/abc.jpg', 'flyers/x.pdf',
    '/moodys/6a2c5e15632a957e4bd75012.jpg', 'MOODYS/6a2c5e15632a957e4bd75012.jpg',
    '', null, undefined, 42,
  ]) {
    assert.equal(snapshotSegments(bad), null, String(bad));
  }
});

import { snapshotsOf } from '../src/lib/flyerPath.js';

test('the dated snapshot names are the only extra shapes allowed', () => {
  const id = '6a2c5e15632a957e4bd75012';
  for (const ok of [`moodys/${id}_listed.jpg`, `moodys/${id}_conditional.jpg`,
    `moodys/${id}_email-new-20260612.jpg`, `moodys/${id}_email-pending-20260916.jpg`]) {
    assert.ok(snapshotSegments(ok), ok);
  }
  for (const bad of [`moodys/${id}_sold.jpg`, `moodys/${id}_email-new-2026.jpg`,
    `moodys/${id}_listed.jpg.exe`, `moodys/${id}__listed.jpg`]) {
    assert.equal(snapshotSegments(bad), null, bad);
  }
});

test('a row’s snapshots read as a history, current last', () => {
  const id = '6a2c5e15632a957e4bd75012';
  const labels = snapshotsOf({
    moodys_snapshots: `moodys/${id}_email-pending-20260916.jpg;moodys/../export/records.csv`,
    moodys_snapshot_path: `moodys/${id}.jpg`,
  }).map((s) => s.label);
  assert.deepEqual(labels, ['Pending (email 2026-09-16)', 'Current'], 'the traversal entry is dropped');
});
