import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, describeFilters, buildWordHtml, buildWordText, xlsxRows, REPORT_KEYS, XLSX_FORMATS,
} from '../src/lib/exports.js';
import { defaultFilters, UNASSIGNED } from '../src/lib/filters.js';
import { EXPORT_FIELDS } from '../src/lib/results.js';

const mk = (id, over = {}) => ({
  id, source: 'kijiji', url: `https://k/${id}`, title: `T${id}`, address: `${id} Main St`, city: 'Winnipeg',
  geo_neighborhood: 'Osborne', geo_mls_area: '1B', geo_municipality: 'CITY OF WINNIPEG', lat: 49.9, lng: -97.1,
  property_type: 'apartment', bedrooms: 1, bathrooms: 1, sqft: 700, rent: 1200, first_seen: '2026-08-01',
  last_seen: '2026-09-13', status: 'active', dedup_canonical: true, cited_in_report: false, evidence_path: null,
  pet_policy: null, parking_included: true, parking_rate: null, laundry: null, elevator: null,
  util_heat: null, util_water: null, util_electricity: null, util_internet: null, util_cable: null,
  furnished: false, rent_observed: '2026-09-13', available_date: null, postal_code: null, ...over,
});
const ctx = { asOf: '2026-09-13', policy: { active_window_days: 60 } };

test('escapeHtml', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('describeFilters: defaults, then every family of criteria', () => {
  assert.deepEqual(describeFilters(defaultFilters(), ctx), [
    'Active listings as of 2026-09-13 (seen within 60 days)',
    'One row per unit (cross-source duplicates removed)',
  ]);
  const f = { ...defaultFilters(), window: '6', types: ['apartment'], beds: ['studio', '1br'],
    munis: ['CITY OF BRANDON', UNASSIGNED], nbhds: ['Osborne'], sources: ['kijiji'], rentLo: '900', rentHi: '1500',
    canonicalOnly: false, sqftLo: '600', pets: 'allowed', subjectLat: '49.9', subjectLng: '-97.1', radiusKm: '2' };
  const lines = describeFilters(f, ctx);
  assert.equal(lines[0], 'Listings observed in the 6 months to 2026-09-13 (from 2026-03-13)');
  assert.ok(lines.includes('Type: Apartment'));
  assert.ok(lines.includes('Bedrooms: Studio, 1 BR'));
  assert.ok(lines.includes('Municipality: CITY OF BRANDON, unassigned'));
  assert.ok(lines.includes('Winnipeg neighbourhood: Osborne'));
  assert.ok(lines.includes('Source: kijiji'));
  assert.ok(lines.includes('Rent $900–$1,500'));
  assert.ok(!lines.some((l) => l.startsWith('One row per unit')));
  assert.equal(lines.at(-1), '≥ 600 sf; Pets allowed; ≤ 2 km of subject');
  const custom = describeFilters({ ...defaultFilters(), window: 'custom', from: '2026-01-01', to: '2026-03-31' }, ctx);
  assert.equal(custom[0], 'Listings observed from 2026-01-01 to 2026-03-31');
  assert.equal(describeFilters({ ...defaultFilters(), window: 'all' }, ctx)[0], 'All observations since scraping began');
});

test('buildWordHtml escapes, styles inline, rules the last row', () => {
  const rows = [mk(1, { address: '<b>1 Main</b> & Co' }), mk(2)];
  const html = buildWordHtml(rows, { title: 'Comps <set>', criteria: ['Rent ≥ $900'], note: 'n=2' });
  assert.ok(html.includes('Comps &lt;set&gt;'));
  assert.ok(html.includes('&lt;b&gt;1 Main&lt;/b&gt; &amp; Co'));
  assert.ok(!html.includes('<b>1 Main'));
  assert.ok(html.includes('Rent ≥ $900'));
  assert.ok(html.includes('font-family:Calibri'));
  assert.equal((html.match(/border-bottom:1\.5pt solid #8B0000/g) || []).length, REPORT_KEYS.length);   // last row only
  assert.equal((html.match(/<tr>/g) || []).length, 3);   // header + 2
  assert.ok(html.endsWith('n=2</p>'));
});

test('buildWordText is TSV with title and criteria first', () => {
  const text = buildWordText([mk(1)], { title: 'T', criteria: ['c1', 'c2'] });
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['T', 'c1', 'c2']);
  assert.equal(lines[3].split('\t').length, REPORT_KEYS.length);
  assert.ok(lines[4].startsWith('1 Main St\tCITY OF WINNIPEG\tOsborne\tapartment\t1\t1\t700\t$1,200\t$1.71'));
});

test('xlsxRows: typed cells, Yes/No booleans, derived fields, CSV field order', () => {
  const l = mk(1, { sqft: -1 }); l._dist = 2.345;
  const { header, rows } = xlsxRows([l]);
  assert.deepEqual(header, EXPORT_FIELDS);
  const rec = Object.fromEntries(header.map((k, i) => [k, rows[0][i]]));
  assert.equal(rec.rent, 1200);
  assert.equal(rec.sqft, null);            // non-positive sqft is not a size
  assert.equal(rec.rent_psf, null);
  assert.equal(rec.distance_km, 2.345);
  assert.equal(rec.parking_included, 'Yes');
  assert.equal(rec.furnished, 'No');
  assert.equal(rec.elevator, null);
  assert.equal(rec.dedup_canonical, 'Yes');
  assert.ok(XLSX_FORMATS.rent.includes('#,##0'));
});

test('tableWordHtml / tableWordText generic tables', async () => {
  const { tableWordHtml, tableWordText } = await import('../src/lib/exports.js');
  const html = tableWordHtml(['Market', 'n', 'Median'], [['Winnipeg <x>', '10', '$1,500'], ['Brandon', '3', '—']], { title: 'By market', criteria: ['c1'], note: 'n1' });
  assert.ok(html.includes('Winnipeg &lt;x&gt;'));
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  assert.equal((html.match(/text-align:right/g) || []).length, 6);   // 2 header + 4 body cells
  assert.equal((html.match(/border-bottom:1\.5pt/g) || []).length, 3);
  const text = tableWordText(['Market', 'n'], [['A', '1']], { title: 'T', criteria: ['c'] });
  assert.equal(text, 'T\nc\nMarket\tn\nA\t1');
  assert.equal(tableWordText(['a'], [['b']]), 'a\nb');
});

test('tableCsv quotes and carries a BOM', async () => {
  const { tableCsv } = await import('../src/lib/exports.js');
  const csv = tableCsv(['Market', 'n'], [['Winnipeg, MB', '1,234'], ['Say "hi"', '—']]);
  assert.ok(csv.startsWith('﻿Market,n\r\n'));
  assert.ok(csv.includes('"Winnipeg, MB","1,234"\r\n'));
  assert.ok(csv.includes('"Say ""hi""",—\r\n'));
});
