/*
 * The filter predicate. The cases worth pinning are the ones where a
 * plausible-looking shortcut would give a wrong market: mixing lease
 * rates with sale prices, counting one space twice, and measuring
 * "current" against the wall clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FILTERS, defaultFilters, applyFilters, describeFilters, isDefault,
  collapseDuplicates, optionsFor, rateOf, priceOf, sizeOf,
  searchTokens, tokenMatches, TEXT_SCOPES,
} from '../src/lib/filters.js';

const MANIFEST = {
  cycles: { first: '2018-01', last: '2026-09', count: 105 },
  on_market_statuses: ['active', 'new', 'conditionally sold', 'conditionally leased'],
  policy: {
    lease_rate_band: [1, 200], sale_price_band: [10000, 500000000],
    size_band_sf: [100, 5000000], min_n: 1,
  },
};

let seq = 0;
const rec = (over = {}) => ({
  listing_id: `L${++seq}`,
  address: '100 Main St', property_name: null, unit: null, city: 'Winnipeg',
  brokerage: 'CBRE', space_type: 'Office', listing_type: 'Lease',
  status: 'Active', first_seen: '2026-01', last_seen: '2026-09',
  municipality: 'City of Winnipeg', neighbourhood: 'ST. JAMES',
  latitude: 49.9, longitude: -97.1,
  sf_min: 1000, sf_max: 1000, land_acres: null,
  current_price: 15, current_price_basis: 'psf_annual', current_price_psf_annual: 15,
  additional_rent: null, comments: null, zoning: null,
  flyer_path: null, dup_group: null,
  ...over,
});

const run = (records, filters) => applyFilters(records, { ...defaultFilters(), ...filters }, MANIFEST);

test('the default view is what is on the market in the newest cycle', () => {
  const records = [
    rec(),
    rec({ last_seen: '2026-07' }),            // gone from the market
    rec({ status: 'Leased' }),                // terminal
  ];
  assert.equal(run(records, {}).length, 1);
  assert.equal(run(records, { market: 'any' }).length, 3);
});

test('a rate bound never matches a sale, and a price bound never a lease', () => {
  const lease = rec({ listing_type: 'Lease', current_price_psf_annual: 12, current_price: 12 });
  const sale = rec({ listing_type: 'Sale', current_price: 500000, current_price_psf_annual: null, current_price_basis: 'sale' });

  // $500,000 is not "over $20/sf/yr"; a sale has no rate at all.
  assert.deepEqual(run([lease, sale], { rateLo: '10' }).map((r) => r.listing_id), [lease.listing_id]);
  assert.deepEqual(run([lease, sale], { priceLo: '100000' }).map((r) => r.listing_id), [sale.listing_id]);
  assert.equal(rateOf(sale), null);
  assert.equal(priceOf(lease), null);
});

test('a price bound excludes unpriced listings rather than treating them as zero', () => {
  const priced = rec({ current_price_psf_annual: 12 });
  const unpriced = rec({ current_price: null, current_price_psf_annual: null });
  assert.deepEqual(run([priced, unpriced], { rateHi: '20' }).map((r) => r.listing_id), [priced.listing_id]);
  // With no bound set, the unpriced listing is still part of the market.
  assert.equal(run([priced, unpriced], {}).length, 2);
});

test('size uses the largest contiguous area on offer', () => {
  const r = rec({ sf_min: 1000, sf_max: 5000 });
  assert.equal(sizeOf(r), 5000);
  assert.equal(run([r], { sfLo: '4000' }).length, 1);
  assert.equal(run([r], { sfHi: '2000' }).length, 0);
});

test('multi-value pickers are OR within a field and AND across fields', () => {
  const records = [
    rec({ space_type: 'Office', brokerage: 'CBRE' }),
    rec({ space_type: 'Retail', brokerage: 'Colliers' }),
    rec({ space_type: 'Industrial', brokerage: 'CBRE' }),
  ];
  assert.equal(run(records, { spaceTypes: ['Office', 'Retail'] }).length, 2);
  assert.equal(run(records, { spaceTypes: ['Office', 'Retail'], brokerages: ['CBRE'] }).length, 1);
  assert.equal(run(records, { spaceTypes: [] }).length, 3, 'an empty picker means any');
});

test('cycle bounds read last_seen', () => {
  const records = [
    rec({ last_seen: '2026-09' }),
    rec({ last_seen: '2020-05', status: 'Delisted' }),
  ];
  assert.equal(run(records, { market: 'any', from: '2021-01' }).length, 1);
  assert.equal(run(records, { market: 'any', to: '2021-01' }).length, 1);
  assert.equal(run(records, { market: 'any', from: '2019-01', to: '2027-01' }).length, 2);
});

test('search covers the fields a person would type into it', () => {
  /* Since the scope switch exists, "the fields a person would type into
     it" depends on which scope is chosen. The default is address, so a
     comment and a zoning code are reachable only from Notes and
     Everything — which is the point of having the switch. */
  const records = [
    rec({ address: '1500 Portage Ave' }),
    rec({ address: null, property_name: 'Water Tower District' }),
    rec({ comments: 'Rear DOCK and yard' }),
    rec({ zoning: 'M2' }),
  ];
  assert.equal(run(records, { text: 'portage' }).length, 1);
  assert.equal(run(records, { text: 'water tower' }).length, 1);
  assert.equal(run(records, { text: 'dock', textScope: 'notes' }).length, 1,
    'search is case-insensitive');
  assert.equal(run(records, { text: 'm2', textScope: 'all' }).length, 1);
  assert.equal(run(records, { text: '   ' }).length, 4, 'blank search filters nothing');
});

test('collapsing duplicates keeps one row per space, priced copy first', () => {
  const g = '1 MAIN ST|5|LEASE';
  const unpriced = rec({ dup_group: g, brokerage: 'CBRE', current_price: null });
  const priced = rec({ dup_group: g, brokerage: 'Colliers', current_price: 14 });
  const other = rec({ dup_group: null });

  const collapsed = collapseDuplicates([unpriced, priced, other]);
  assert.equal(collapsed.length, 2);
  assert.ok(collapsed.includes(priced), 'the copy with a price survives');
  assert.ok(collapsed.includes(other), 'a non-duplicate is untouched');
  assert.equal(run([unpriced, priced, other], { collapseDuplicates: true }).length, 2);
  assert.equal(run([unpriced, priced, other], {}).length, 3);
});

test('duplicate collapse is deterministic when the copies tie', () => {
  const g = 'G';
  const a = rec({ listing_id: 'AAA', dup_group: g, current_price: 10 });
  const b = rec({ listing_id: 'BBB', dup_group: g, current_price: 10 });
  assert.deepEqual(collapseDuplicates([a, b]).map((r) => r.listing_id), ['AAA']);
  assert.deepEqual(collapseDuplicates([b, a]).map((r) => r.listing_id), ['AAA']);
});

test('plausible-only drops the mislabelled yard rents', () => {
  const sane = rec({ current_price_psf_annual: 12 });
  const yard = rec({ current_price_psf_annual: 37800, space_type: 'Land' });
  assert.equal(run([sane, yard], {}).length, 2, 'they are still real listings');
  assert.deepEqual(run([sane, yard], { plausibleOnly: true }).map((r) => r.listing_id), [sane.listing_id]);
});

test('flyer and map toggles', () => {
  const withFlyer = rec({ flyer_path: 'flyers/CBRE/x.pdf' });
  const unmapped = rec({ latitude: null, longitude: null });
  const plain = rec();
  assert.equal(run([withFlyer, unmapped, plain], { hasFlyer: true }).length, 1);
  assert.equal(run([withFlyer, unmapped, plain], { mappedOnly: true }).length, 2);
});

test('Moody\'s-only listings are in by default and can be left out', () => {
  // 705 Broadway: a real listing no brokerage source carried. It belongs
  // in a search, but a trend across April 2026 (when the grid archive
  // began) wants it out.
  const moodys = rec({ record_source: 'moodys' });
  const broker = rec({ record_source: '' });
  const older = rec(); // a folder published before record_source existed
  assert.equal(run([moodys, broker, older], {}).length, 3);
  assert.equal(run([moodys, broker, older], { brokerageSourcesOnly: true }).length, 2);
  assert.ok(describeFilters({ ...defaultFilters(), brokerageSourcesOnly: true }, MANIFEST)
    .some((c) => c.label === 'Brokerage sources only'));
});

test('chips always state the market rule, then each active filter', () => {
  const chips = describeFilters({ ...defaultFilters(), spaceTypes: ['Office'], rateHi: '20' }, MANIFEST);
  assert.equal(chips[0].key, 'market');
  assert.match(chips[0].label, /2026-09/);
  assert.ok(chips.some((c) => c.label === 'Type: Office'));
  assert.ok(chips.some((c) => c.label.includes('$0–$20/sf/yr')));
});

test('isDefault knows when nothing has been narrowed', () => {
  assert.equal(isDefault(defaultFilters()), true);
  assert.equal(isDefault({ ...defaultFilters(), text: 'x' }), false);
  assert.equal(isDefault({ ...defaultFilters(), spaceTypes: ['Office'] }), false);
  assert.equal(isDefault({ ...DEFAULT_FILTERS }), true);
});

test('picker options are counted and ordered by frequency', () => {
  const records = [rec({ brokerage: 'CBRE' }), rec({ brokerage: 'CBRE' }), rec({ brokerage: 'Colliers' }), rec({ brokerage: null })];
  assert.deepEqual(optionsFor(records, 'brokerage'), [
    { value: 'CBRE', label: 'CBRE', count: 2 },
    { value: 'Colliers', label: 'Colliers', count: 1 },
  ]);
});

// ---------- searching by address ----------
//
// The box was a contiguous substring, which meant knowing how the source
// spelled the street type and where it put the punctuation: "st marys rd"
// found none of the nine St. Mary's Road listings, and "101 Regent W"
// missed "101 Regent Avenue W".

const addr = (address, over = {}) => rec({ address, ...over });

test('punctuation in the data is not something anyone should have to type', () => {
  const rows = [addr("1010 St. Mary's Road"), addr('90 Bole Street')];
  assert.equal(run(rows, { text: 'st marys rd' }).length, 1);
  assert.equal(run(rows, { text: "St. Mary's Road" }).length, 1);
});

test('a street type may be abbreviated on either side, or left out', () => {
  /* A prefix rule alone cannot do this: "ave" is the start of "avenue"
     but "rd" is not the start of "road", so the types are expanded on
     both sides before anything is compared. */
  const rows = [addr('101 Regent Avenue W'), addr('2100 Portage Ave')];
  assert.equal(run(rows, { text: '101 Regent W' }).length, 1, 'type omitted');
  assert.equal(run(rows, { text: '101 Regent Ave W' }).length, 1, 'abbreviated');
  assert.equal(run(rows, { text: '2100 Portage Avenue' }).length, 1, 'spelled out');
  assert.equal(run(rows, { text: '2100 portage' }).length, 1);
});

test('a civic number is exact, never a prefix', () => {
  /* The rule that keeps token matching honest: "105 Main" must not find
     1050 Main Street, however forgiving the rest of the query is. */
  const rows = [addr('1050 Main Street'), addr('105 Main Street')];
  assert.deepEqual(run(rows, { text: '105 Main' }).map((r) => r.address), ['105 Main Street']);
  assert.deepEqual(run(rows, { text: '1050 Main' }).map((r) => r.address), ['1050 Main Street']);
});

test('a letter suffix is the same door', () => {
  assert.equal(run([addr('1076A Main Street')], { text: '1076 Main' }).length, 1);
  assert.equal(run([addr('1076A Main Street')], { text: '107 Main' }).length, 0);
});

test('word order is not part of an address', () => {
  assert.equal(run([addr('1500 Portage Avenue')], { text: 'Portage 1500' }).length, 1);
});

test('every word must land in ONE field, not scattered across several', () => {
  /* Otherwise an address matches a comment that happens to share a word,
     and the result reads as a hit on neither. */
  const rows = [addr('90 Bole Street', { comments: 'near Portage Avenue' })];
  assert.equal(run(rows, { text: 'Bole Street' }).length, 1);
  assert.equal(run(rows, { text: 'Portage Avenue', textScope: 'all' }).length, 1,
    'both words are in comments');
  assert.equal(run(rows, { text: 'Bole Portage', textScope: 'all' }).length, 0,
    'one word from each');
});

test('a pasted roll number still finds its listings', () => {
  const rows = [addr('221 Portage Avenue', { roll_number: '13052166000' }),
    addr('90 Bole Street', { roll_number: '13052199999' })];
  assert.equal(run(rows, { text: '13052166000' }).length, 1);
});

test('the search still finds what it always found', () => {
  const rows = [addr('90 Bole Street', { property_name: 'Water Tower', zoning: 'M2' })];
  assert.equal(run(rows, { text: 'water tower' }).length, 1);
  assert.equal(run(rows, { text: 'M2', textScope: 'all' }).length, 1);
  assert.equal(run(rows, { text: 'm2', textScope: 'all' }).length, 1, 'still case-insensitive');
  assert.equal(run(rows, { text: '  ' }).length, 1, 'blank still filters nothing');
});

test('tokenising is punctuation-blind and drops nothing else', () => {
  assert.deepEqual(searchTokens("1010 St. Mary's Road"), ['1010', 'st', 'marys', 'road']);
  assert.deepEqual(searchTokens('1050-1054 Main St'), ['1050', '1054', 'main', 'st']);
  assert.deepEqual(searchTokens('   '), []);
  assert.deepEqual(searchTokens(null), []);
});

test('the token rule, stated once', () => {
  assert.equal(tokenMatches('ave', 'avenue'), true);
  assert.equal(tokenMatches('avenue', 'ave'), true);
  assert.equal(tokenMatches('rd', 'road'), true, 'a contraction, not a prefix');
  assert.equal(tokenMatches('blvd', 'boulevard'), true);
  assert.equal(tokenMatches('boulevard', 'blvd'), true);
  assert.equal(tokenMatches('porta', 'portage'), true, 'a half-typed street name');
  assert.equal(tokenMatches('105', '1050'), false, 'a number is not a prefix');
  assert.equal(tokenMatches('1076', '1076a'), true, 'but a letter suffix is the same door');
  assert.equal(tokenMatches('1076', '1076ab'), false);
});

// ---------- where the search box looks ----------
//
// One box searching seven fields at once meant an address query returned
// roughly three times the rows you wanted, with nothing on screen saying
// which was which: "wilkes ave" was 197 records, 64 of them AT an address
// on Wilkes and 137 merely mentioning it in a comment.

const mixed = () => [
  rec({ address: '8785 Wilkes Avenue', comments: 'near the Perimeter' }),
  rec({ address: '90 Bole Street', comments: 'two blocks off Wilkes Avenue' }),
];

test('address is the default scope, and it is the identity fields', () => {
  assert.equal(DEFAULT_FILTERS.textScope, 'address');
  assert.deepEqual(TEXT_SCOPES.address, ['address', 'property_name', 'unit', 'roll_number']);
});

test('searching an address does not drag in what a comment mentions', () => {
  const got = run(mixed(), { text: 'Wilkes Avenue' });
  assert.deepEqual(got.map((r) => r.address), ['8785 Wilkes Avenue']);
});

test('notes searches the comments and nothing else', () => {
  const got = run(mixed(), { text: 'Wilkes Avenue', textScope: 'notes' });
  assert.deepEqual(got.map((r) => r.address), ['90 Bole Street']);
});

test('everything is what the box did before the scope existed', () => {
  assert.equal(run(mixed(), { text: 'Wilkes Avenue', textScope: 'all' }).length, 2);
});

test('city and zoning answer only to Everything', () => {
  /* Both have their own filter, and "Portage" in the address scope must
     not pull in every listing in Portage la Prairie. */
  const rows = [rec({ address: '90 Bole Street', city: 'Portage la Prairie', zoning: 'M2' })];
  assert.equal(run(rows, { text: 'Portage' }).length, 0);
  assert.equal(run(rows, { text: 'M2' }).length, 0);
  assert.equal(run(rows, { text: 'Portage', textScope: 'all' }).length, 1);
  assert.equal(run(rows, { text: 'M2', textScope: 'all' }).length, 1);
});

test('a roll number is an address, not a note', () => {
  const rows = [rec({ roll_number: '13052166000' })];
  assert.equal(run(rows, { text: '13052166000' }).length, 1);
  assert.equal(run(rows, { text: '13052166000', textScope: 'notes' }).length, 0);
});

test('an unknown scope falls back to address rather than matching nothing', () => {
  assert.equal(run(mixed(), { text: 'Wilkes Avenue', textScope: 'nonsense' }).length, 1);
});

test('the chip says WHERE it looked, so an export can state it', () => {
  const label = (over) => describeFilters({ text: 'dock', ...over }, MANIFEST)
    .find((c) => c.key === 'text').label;
  assert.equal(label({}), '“dock” in address');
  assert.equal(label({ textScope: 'notes' }), '“dock” in notes');
  assert.equal(label({ textScope: 'all' }), '“dock” anywhere');
});

test('the scope alone is not a narrowed view', () => {
  /* "Clear all" must not light up because a radio is sitting on its
     default, and an empty box searches nothing wherever it is pointed. */
  assert.equal(isDefault({ ...defaultFilters(), textScope: 'address' }), true);
  assert.equal(run(mixed(), { text: '', textScope: 'notes' }).length, 2);
});
