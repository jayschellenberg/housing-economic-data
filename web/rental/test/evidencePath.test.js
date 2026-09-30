import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLayout, evidenceSegments } from '../src/lib/evidencePath.js';

test('detectLayout: parent folder, export folder, junk', () => {
  assert.deepEqual(detectLayout({ dirs: ['export', 'evidence', 'data'], files: ['index.html'] }), { layout: 'parent', evidence: true });
  assert.deepEqual(detectLayout({ dirs: ['export'], files: [] }), { layout: 'parent', evidence: false });
  assert.deepEqual(detectLayout({ dirs: [], files: ['manifest.json', 'listings.csv'] }), { layout: 'export', evidence: false });
  assert.throws(() => detectLayout({ dirs: ['photos'], files: ['notes.txt'] }), /Not the RentalDashboard folder/);
});

test('evidenceSegments accepts bundle paths and refuses escapes', () => {
  assert.deepEqual(evidenceSegments('evidence/2026-09-14/kijiji/123.html'), { dirs: ['evidence', '2026-09-14', 'kijiji'], file: '123.html' });
  for (const bad of ['', null, 'data/rentals.db', 'evidence/../export/manifest.json', 'evidence//x.html',
    '/evidence/a.html', 'evidence/a.png', 'evidence/2026\\kijiji\\1.html', 'evidence/C:/x.html', 'evidence']) {
    assert.equal(evidenceSegments(bad), null, String(bad));
  }
});
