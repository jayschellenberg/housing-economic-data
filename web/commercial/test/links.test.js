/*
 * What a grid row can open: its flyer, its Moody's snapshot, and the
 * property on Moody's own site.
 *
 * The flyer link existed but nobody could find it — an unlabelled 23rd
 * column whose first button sat 1,700px to the right of a 1,400px screen.
 * It now lives in a "Links" column right after Address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { linksOf, MOODYS_PROPERTY_URL, MOODYS_MEMBERS_URL, COLUMN_KEYS } from '../src/lib/results.js';

const ID = '5dcc90c512e2520001ed60e5';

test('a row with nothing to open offers nothing', () => {
  assert.deepEqual(linksOf({}), []);
  assert.deepEqual(linksOf(null), []);
});

test('a flyer opens in the page, from the connected folder', () => {
  const [flyer] = linksOf({ flyer_path: 'flyers/Colliers/CAN2015419_20260401.pdf' });
  assert.equal(flyer.kind, 'flyer');
  assert.equal(flyer.href, undefined, 'a file in the folder, not a URL to fetch');
});

test('the Moody’s link is the property page the id was read from', () => {
  /* The scraper takes moodys_id out of the grid's /marketplace/property/{id}
     links; on the 2026-09-20 snapshot all 874 rows round-trip exactly. */
  const link = linksOf({ moodys_id: ID }).find((l) => l.kind === 'moodys');
  assert.equal(link.href, `${MOODYS_PROPERTY_URL}${ID}`);
  assert.ok(link.href.startsWith('https://www.moodyscre.com/marketplace/property/'));
});

test('an id that is not a Moody’s id never becomes a link', () => {
  /* It arrives from a CSV in a shared folder. Anything that is not the
     hex shape the scraper extracts has no business in an href. */
  for (const bad of ['javascript:alert(1)', '../../etc', '5dcc 90c5', 'short', '', null]) {
    assert.equal(linksOf({ moodys_id: bad }).length, 0, String(bad));
  }
});

test('a snapshot is offered only when the folder has one', () => {
  assert.equal(linksOf({ moodys_id: ID }).some((l) => l.kind === 'snapshot'), false);
  const kinds = linksOf({ moodys_id: ID, moodys_snapshot_path: `moodys/${ID}.jpg` }).map((l) => l.kind);
  assert.ok(kinds.includes('snapshot'));
});

test('links come in a stable order: flyer, snapshot, then the site', () => {
  const kinds = linksOf({
    flyer_path: 'flyers/x.pdf', moodys_snapshot_path: `moodys/${ID}.jpg`, moodys_id: ID,
  }).map((l) => l.kind);
  assert.deepEqual(kinds, ['flyer', 'snapshot', 'moodys']);
});

test('the Links column is not a data column — it is not exported or sorted', () => {
  assert.equal(COLUMN_KEYS.includes('links'), false);
});

test('one Snapshots link covers the whole dated history', () => {
  /* Listed, the email cards and Conditional open in ONE dialog with a
     picker, rather than five links crowding the cell. */
  const [snap] = linksOf({
    moodys_snapshots: `moodys/${ID}_email-new-20260612.jpg;moodys/${ID}_listed.jpg;moodys/${ID}_conditional.jpg`,
    moodys_snapshot_path: `moodys/${ID}.jpg`,
  }).filter((l) => l.kind === 'snapshot');
  assert.equal(snap.label, 'Snapshots (4)');
  assert.equal(snap.title, 'New (email 2026-06-12) · Listed · Conditional · Current');
});

test('with the listing id, the Moody’s link opens the members-site listing', () => {
  // 588 Sargent, the page Jason asked for (2026-09-24).
  const r = { moodys_id: '69d563e50e26511e854654a1', moodys_public_id: '69d56df2b8bb3b4b8d1703a8' };
  const link = linksOf(r).find((l) => l.kind === 'moodys');
  assert.equal(link.href, `${MOODYS_MEMBERS_URL}69d563e50e26511e854654a1/69d56df2b8bb3b4b8d1703a8`);
});

test('a numeric or junk listing id falls back to the public property page', () => {
  for (const bad of ['44664431', 'x"><script>', '']) {
    const link = linksOf({ moodys_id: ID, moodys_public_id: bad }).find((l) => l.kind === 'moodys');
    assert.equal(link.href, MOODYS_PROPERTY_URL + ID);
  }
});
