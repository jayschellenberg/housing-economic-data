/*
 * The text side of the exports. What matters here is that an exported
 * table cannot lose the question that produced it, and that a number
 * reaches Excel as a number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml, REPORT_KEYS, provenanceLines, buildWordHtml, buildWordText,
  xlsxRows, XLSX_FORMATS,
} from '../src/lib/exports.js';
import { COLUMNS } from '../src/lib/results.js';

const rec = (over = {}) => ({
  listing_id: 'L1', address: '100 Main St', unit: 'Unit 2', property_name: null,
  city: 'Winnipeg', municipality: 'City of Winnipeg', neighbourhood: 'ST. JAMES',
  brokerage: 'CBRE', space_type: 'Office', listing_type: 'Lease', status: 'Active',
  first_seen: '2026-01', last_seen: '2026-09', months_on_market: 9,
  sf_min: 1500, sf_max: 1500, land_acres: null, zoning: 'M2',
  current_price: 15.5, current_price_basis: 'psf_annual', current_price_psf_annual: 15.5,
  additional_rent: 6.25, latitude: 49.9, longitude: -97.1, flyer_path: null,
  ...over,
});

const CTX = {
  chips: [{ label: 'On the market (2026-09)' }, { label: 'Type: Office' }],
  published: 'Sep 14, 2026',
  cycle: '2026-09',
};

test('html escaping covers the characters that break a pasted table', () => {
  assert.equal(escapeHtml('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;');
  assert.equal(escapeHtml(null), '');
});

test('the provenance lines carry count, filters, cycle and publish date', () => {
  const lines = provenanceLines({ ...CTX, count: 42 });
  assert.equal(lines[0], '42 listings');
  assert.ok(lines.includes('On the market (2026-09)'));
  assert.ok(lines.includes('Type: Office'));
  assert.ok(lines.includes('Data cycle 2026-09'));
  assert.ok(lines.includes('Published Sep 14, 2026'));
});

test('the Word table states what it is before the first row', () => {
  const html = buildWordHtml([rec()], { title: 'Office space', ...CTX });
  const beforeTable = html.slice(0, html.indexOf('<table'));
  assert.ok(beforeTable.includes('Office space'));
  assert.ok(beforeTable.includes('On the market (2026-09)'));
  assert.ok(beforeTable.includes('Published Sep 14, 2026'));
});

test('the Word table is narrower than the grid, and bordered', () => {
  const html = buildWordHtml([rec()], CTX);
  // Word ignores a stylesheet; without inline borders this pastes as a
  // run-on paragraph.
  assert.ok(html.includes('border:1px solid #999'));
  assert.ok(html.includes('border-collapse:collapse'));
  const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.equal(headers.length, REPORT_KEYS.length);
  assert.ok(headers.length < COLUMNS.length, 'a report table is not the whole grid');
  assert.ok(headers.includes('Address'));
});

test('a comma, a quote and an ampersand survive the trip', () => {
  const html = buildWordHtml([rec({ address: 'Unit 5, "Rear" & yard' })], CTX);
  assert.ok(html.includes('Unit 5, &quot;Rear&quot; &amp; yard'));
  assert.ok(!html.includes('"Rear"'), 'raw quotes would break the attribute soup');
});

test('the plain-text twin is tab separated and keeps the heading', () => {
  const text = buildWordText([rec()], { title: 'Office space', ...CTX });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Office space');
  assert.ok(lines.some((l) => l.includes('Published Sep 14, 2026')));
  const header = lines.find((l) => l.startsWith('Address'));
  assert.ok(header.includes('\t'));
  assert.equal(header.split('\t').length, REPORT_KEYS.length);
});

test('Excel gets numbers as numbers, not as formatted text', () => {
  const { header, labels, rows } = xlsxRows([rec()]);
  const row = rows[0];
  const at = (key) => row[header.indexOf(key)];
  assert.equal(at('size'), 1500, 'not "1,500"');
  assert.equal(at('rate'), 15.5, 'not "$15.50"');
  assert.equal(at('months_on_market'), 9);
  assert.equal(at('address'), '100 Main St');
  assert.equal(labels[header.indexOf('rate')], '$/sf/yr', 'the sheet is headed for humans');
});

test('an absent number is blank, never zero', () => {
  const { header, rows } = xlsxRows([rec({ sf_min: null, sf_max: null, additional_rent: null })]);
  assert.equal(rows[0][header.indexOf('size')], null);
  assert.equal(rows[0][header.indexOf('additional_rent')], null);
});

test('every formatted column is a numeric one', () => {
  for (const key of Object.keys(XLSX_FORMATS)) {
    const col = COLUMNS.find((c) => c.key === key);
    assert.ok(col, `${key} is not a column`);
    assert.ok(col.num, `${key} has a number format but is not numeric`);
  }
});
