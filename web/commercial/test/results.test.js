/*
 * The grid's columns, sorting, paging, count line and CSV.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLUMNS, COLUMN_KEYS, sortRows, pageOf, pageCount, summarize, countLine, medianLine,
  toCsv, askingText, addressOf, areaOf, conditionalText, dateText,
} from '../src/lib/results.js';

const MANIFEST = {
  policy: {
    lease_rate_band: [1, 200], sale_price_band: [10000, 500000000],
    size_band_sf: [100, 5000000], min_n: 1,
  },
};

let seq = 0;
const rec = (over = {}) => ({
  listing_id: `L${++seq}`,
  address: '100 Main St', property_name: null, unit: null, city: 'Winnipeg',
  neighbourhood: null, cluster: null, municipality: 'City of Winnipeg',
  brokerage: 'CBRE', space_type: 'Office', listing_type: 'Lease', status: 'Active',
  first_seen: '2026-01', last_seen: '2026-09', months_on_market: 9,
  sf_min: 1000, sf_max: 1000, land_acres: null, zoning: null,
  current_price: 15, current_price_basis: 'psf_annual', current_price_psf_annual: 15,
  additional_rent: null, latitude: 49.9, longitude: -97.1, flyer_path: null,
  ...over,
});

test('asking text carries its basis, so a rate is never read as a price', () => {
  assert.equal(askingText(rec({ current_price: 15, current_price_basis: 'psf_annual' })), '$15.00/sf/yr');
  assert.equal(askingText(rec({ listing_type: 'Sale', current_price: 1250000, current_price_basis: 'sale' })), '$1,250,000');
  assert.equal(askingText(rec({ current_price: 3500, current_price_basis: 'total_monthly' })), '$3,500/mo');
  assert.equal(askingText(rec({ current_price: null })), '');
});

test('a per-sf quote the pipeline would not certify drops the unit', () => {
  // 12 Headingley St: a $37,800 monthly yard rent stored as psf_annual.
  // pass2 withholds the derived rate; the cell must not re-assert /sf/yr.
  const withheld = rec({
    current_price: 37800, current_price_basis: 'psf_annual',
    current_price_psf_annual: null,
  });
  assert.equal(askingText(withheld), '$37,800 (unit unverified)');
  assert.ok(!askingText(withheld).includes('/sf'), 'the refused claim is not repeated');
  // A certified rate is untouched.
  assert.equal(askingText(rec({ current_price: 15, current_price_psf_annual: 15 })), '$15.00/sf/yr');
  // A sale is a price, not a rate, and never gets the qualifier.
  assert.equal(askingText(rec({
    listing_type: 'Sale', current_price: 1250000,
    current_price_basis: 'sale', current_price_psf_annual: null,
  })), '$1,250,000');
});

test('the address cell never renders blank', () => {
  assert.equal(addressOf(rec({ address: '1 Main St' })), '1 Main St');
  assert.equal(addressOf(rec({ address: null, property_name: 'Water Tower' })), 'Water Tower');
  assert.equal(addressOf(rec({ address: null, property_name: null })), '(no address)');
});

test('area shows the geography below the municipality, never a repeat of it', () => {
  assert.equal(areaOf(rec({ neighbourhood: 'ST. JAMES' })), 'ST. JAMES');
  assert.equal(areaOf(rec({ neighbourhood: null, cluster: 'WEST' })), 'WEST');
  // Rural records have no neighbourhood; Municipality has its own column,
  // so falling back to it here only printed 'RM of Headingley' twice.
  assert.equal(areaOf(rec({ neighbourhood: null, cluster: null })), '');
});

test('blanks sort last in both directions — an unpriced listing is not cheapest', () => {
  const priced = rec({ current_price_psf_annual: 12 });
  const dear = rec({ current_price_psf_annual: 30 });
  const none = rec({ current_price_psf_annual: null, current_price: null });
  assert.deepEqual(sortRows([none, dear, priced], 'rate', 'asc').map((r) => r.listing_id),
    [priced.listing_id, dear.listing_id, none.listing_id]);
  assert.deepEqual(sortRows([none, priced, dear], 'rate', 'desc').map((r) => r.listing_id),
    [dear.listing_id, priced.listing_id, none.listing_id]);
});

test('sorting is stable for equal values', () => {
  const a = rec({ address: 'Same' }), b = rec({ address: 'Same' }), c = rec({ address: 'Same' });
  assert.deepEqual(sortRows([a, b, c], 'address', 'asc').map((r) => r.listing_id),
    [a.listing_id, b.listing_id, c.listing_id]);
});

test('addresses sort the way a person reads them', () => {
  const rows = [rec({ address: '1500 Portage' }), rec({ address: '200 Portage' }), rec({ address: '30 Portage' })];
  assert.deepEqual(sortRows(rows, 'address', 'asc').map((r) => r.address),
    ['30 Portage', '200 Portage', '1500 Portage']);
});

test('units render as a count and never as an area', () => {
  const col = COLUMNS.find((c) => c.key === 'units');
  assert.ok(col && col.num, 'units is a numeric column');
  assert.equal(col.text({ units: 52 }), '52');
  assert.equal(col.text({ units: null }), '', 'blank for everything but multifamily');
  // The size column must stay empty for a row whose count was moved out.
  assert.equal(COLUMNS.find((c) => c.key === 'size').text({ units: 52 }), '');
});

test('paging', () => {
  const rows = Array.from({ length: 250 }, () => rec());
  assert.equal(pageCount(250, 100), 3);
  assert.equal(pageOf(rows, 1, 100).length, 100);
  assert.equal(pageOf(rows, 3, 100).length, 50);
  assert.equal(pageOf(rows, 9, 100).length, 0);
  assert.equal(pageCount(0, 100), 1, 'an empty result is still one page');
});

test('the count line separates lease from sale, and medians from each other', () => {
  const rows = [
    rec({ listing_type: 'Lease', current_price_psf_annual: 10 }),
    rec({ listing_type: 'Lease', current_price_psf_annual: 20 }),
    rec({ listing_type: 'Sale', current_price: 1000000, current_price_psf_annual: null }),
  ];
  const stats = summarize(rows, MANIFEST);
  assert.equal(stats.total, 3);
  assert.equal(stats.lease, 2);
  assert.equal(stats.sale, 1);
  assert.equal(stats.medianRate, 15);
  assert.equal(stats.medianPrice, 1000000);
  assert.match(countLine(stats), /3 listings · 2 lease · 1 sale/);
  assert.match(medianLine(stats), /median rate \$15\.00\/sf\/yr \(n=2\)/);
  assert.match(medianLine(stats), /median price \$1,000,000/);
});

test('excluded values are reported on the count line, not hidden', () => {
  const rows = [
    rec({ current_price_psf_annual: 12 }),
    rec({ current_price_psf_annual: 37800 }),
  ];
  const stats = summarize(rows, MANIFEST);
  assert.equal(stats.medianRate, 12);
  assert.equal(stats.excluded, 1);
  assert.match(medianLine(stats), /1 implausible value excluded/);
});

test('CSV quotes commas and doubles embedded quotes', () => {
  const rows = [rec({ address: 'Unit 5, 100 Main St', zoning: 'M2 "heavy"' })];
  const csv = toCsv(rows);
  const [header, row] = csv.trim().split('\r\n');
  assert.equal(header.split(',')[0], 'Address');
  assert.ok(row.includes('"Unit 5, 100 Main St"'));
  assert.ok(row.includes('"M2 ""heavy"""'));
});

test('CSV carries what it was filtered to, so it can be read six months later', () => {
  const csv = toCsv([rec()], {
    chips: [{ label: 'On the market (2026-09)' }, { label: 'Type: Office' }],
    published: 'Sep 14, 2026',
  });
  const first = csv.split('\r\n')[0];
  assert.match(first, /^# Published Sep 14, 2026 \| On the market \(2026-09\) \| Type: Office$/);
});

test('every column renders a string for a record with nothing in it', () => {
  const empty = {};
  for (const col of COLUMNS) {
    assert.equal(typeof col.text(empty), 'string', col.key);
  }
});

test('conditional column: blank until a listing goes conditional', () => {
  assert.equal(conditionalText({}), '');
  assert.equal(conditionalText({ relisted_date: '2026-04' }), '',
    'a relist without a conditional is not a state the pipeline can produce');
});

test('conditional column: the date alone while it still holds', () => {
  assert.equal(conditionalText({ conditional_date: '2024-04' }), '2024-04');
});

test('conditional column: both dates once the listing came back', () => {
  assert.equal(
    conditionalText({ conditional_date: '2024-04', relisted_date: '2026-04' }),
    '2024-04 → 2026-04');
});

test('conditional column: a same-month bounce shows the month twice', () => {
  // 897-899 Henderson Highway went conditional and returned in 2022-11.
  // status_history is month-keyed, so this is a real answer, not a glitch.
  assert.equal(
    conditionalText({ conditional_date: '2022-11', relisted_date: '2022-11' }),
    '2022-11 → 2022-11');
});

test('conditional column sorts by when it went conditional, not the text', () => {
  const col = COLUMNS.find((c) => c.key === 'conditional');
  assert.equal(col.get({ conditional_date: '2024-04', relisted_date: '2026-04' }), '2024-04');
  assert.equal(col.get({}), '');
});

test('the grid carries one conditional column, not two', () => {
  // Two sparse columns would cost twice the width to say the same thing.
  assert.ok(COLUMN_KEYS.includes('conditional'));
  assert.ok(!COLUMN_KEYS.includes('conditional_date'));
  assert.ok(!COLUMN_KEYS.includes('relisted_date'));
});

test('a month-only date says so; a real day does not', () => {
  // 588 Sargent: Moody's List Date 2026-04-08; conditional only per CBRE's
  // June report, which the pipeline puts on the 1st.
  assert.equal(dateText('2026-04-08', 'moodys-listing'), '2026-04-08');
  assert.equal(dateText('2026-06-01', 'report-month'), '2026-06-01 (report)');
  assert.equal(dateText('', 'report-month'), '');
  assert.equal(conditionalText({ conditional_date: '2026-03-01', conditional_date_source: 'report-month',
    relisted_date: '2026-05-09', relisted_date_source: 'moodys-email' }),
  '2026-03-01 (report) → 2026-05-09');
});
