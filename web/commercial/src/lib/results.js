/*
 * results.js — what the grid shows and exports: the column catalogue,
 * sorting, paging, the count-line statistics, and the CSV serializer.
 * Pure; tested under node.
 */

import { rateOf, priceOf, sizeOf } from './filters.js';
import { guardedMedian, policy } from './summary.js';
import { snapshotsOf } from './flyerPath.js';

const fmtInt = (n) => (n == null ? '' : Math.round(n).toLocaleString('en-CA'));
const fmtMoney = (n) => (n == null ? '' : `$${Math.round(n).toLocaleString('en-CA')}`);
const fmtRate = (n) => (n == null ? '' : `$${Number(n).toFixed(2)}`);
const isPerSf = (basis) => basis === 'psf_annual' || basis === 'psf_monthly';

/** The finest geography we have BELOW the municipality, which has its
 *  own column — falling back to it here just prints it twice. The
 *  fallback to `cluster` never fires on real data (pass4 stamps both
 *  from one polygon or neither) and is kept only so a hand-made record
 *  with a cluster and no neighbourhood still reads as somewhere. */
export const areaOf = (r) => r.neighbourhood || r.cluster || '';

/** What the address cell reads — address, else the property name. */
export const addressOf = (r) => r.address || r.property_name || '(no address)';

/** Asking, in whichever unit the listing is actually quoted in. The
 *  basis travels with the number so a rate and a price never merge. */
export function askingText(r) {
  if (r.current_price == null) return '';
  const basis = r.current_price_basis || '';
  if (r.listing_type === 'Sale' || basis === 'sale') return fmtMoney(r.current_price);
  // A per-sf basis the pipeline declined to certify. current_price_psf_annual
  // is the producer's blessing on the unit; when it is absent for a per-sf
  // quote, the unit itself is what is in doubt — 12 Headingley St is a
  // $37,800 monthly yard rent that a scraper labelled psf_annual. The
  // aggregates already exclude it, but repeating "/sf/yr" in the cell would
  // still assert the claim the pipeline just refused. Show the amount, drop
  // the unit.
  if (isPerSf(basis) && r.current_price_psf_annual == null) {
    return `${fmtMoney(r.current_price)} (unit unverified)`;
  }
  if (basis === 'psf_annual') return `${fmtRate(r.current_price)}/sf/yr`;
  if (basis === 'psf_monthly') return `${fmtRate(r.current_price)}/sf/mo`;
  if (basis === 'total_monthly') return `${fmtMoney(r.current_price)}/mo`;
  if (basis === 'total_annual') return `${fmtMoney(r.current_price)}/yr`;
  return fmtMoney(r.current_price);
}

/**
 * Table columns. `get` yields the raw sortable value; `text` the cell
 * string. `num` right-aligns and sorts numerically.
 */
/** A date as a cell shows it. Since 2026-09-24 the pipeline dates to the
 *  day where any source did (Moody's List Date, an alert email) and puts a
 *  month-only date on the 1st, marked "report-month" — so that 1st says
 *  "(report)" rather than claim a day nobody recorded. */
export function dateText(day, source) {
  if (!day) return '';
  return source === 'report-month' ? `${day} (report)` : String(day);
}

/** "2026-06-17" while it holds, "2026-03-01 (report) → 2026-05-09" once the
 *  listing came back. Blank for a listing that never went conditional,
 *  which is most of them. */
export function conditionalText(r) {
  const went = dateText(r?.conditional_date, r?.conditional_date_source);
  if (!went) return '';
  const back = dateText(r?.relisted_date, r?.relisted_date_source);
  return back ? `${went} → ${back}` : went;
}

/** One roll, or "3 rolls" — a condo stack shares a footprint and the
 *  stamp keeps every roll on it, which is a fact about the site rather
 *  than a list anyone wants in a table cell. The full set is still in
 *  `roll_number` for the search box and the CSV. */
export function rollText(r) {
  const raw = r?.roll_number || '';
  if (!raw) return '';
  const rolls = String(raw).split(';').filter(Boolean);
  return rolls.length > 1 ? `${rolls.length} rolls` : rolls[0];
}

export const COLUMNS = Object.freeze([
  { key: 'address', label: 'Address', get: (r) => addressOf(r), text: (r) => addressOf(r) },
  { key: 'unit', label: 'Unit', get: (r) => r.unit || '', text: (r) => r.unit || '' },
  { key: 'area', label: 'Area', get: (r) => areaOf(r), text: (r) => areaOf(r) },
  // The tier between Area and Municipality: 194 Winnipeg neighbourhoods
  // roll up into 23 clusters, and a cluster is the coarsest grouping that
  // still reads as a submarket. Blank outside Winnipeg.
  { key: 'cluster', label: 'Cluster', get: (r) => r.cluster || '', text: (r) => r.cluster || '' },
  { key: 'municipality', label: 'Municipality', get: (r) => r.municipality || r.city || '', text: (r) => r.municipality || r.city || '' },
  { key: 'space_type', label: 'Type', get: (r) => r.space_type || '', text: (r) => r.space_type || '' },
  { key: 'listing_type', label: 'Sale/Lease', get: (r) => r.listing_type || '', text: (r) => r.listing_type || '' },
  { key: 'size', label: 'Size (sf)', num: true, get: (r) => sizeOf(r), text: (r) => fmtInt(sizeOf(r)) },
  { key: 'land_acres', label: 'Acres', num: true, get: (r) => r.land_acres, text: (r) => (r.land_acres == null ? '' : String(r.land_acres)) },
  // Dwelling count, not an area. Blank for everything but multifamily, the
  // same way Acres is blank for everything but land.
  { key: 'units', label: 'Units', num: true, get: (r) => r.units ?? null, text: (r) => (r.units == null ? '' : fmtInt(r.units)) },
  { key: 'asking', label: 'Asking', num: true, get: (r) => r.current_price, text: (r) => askingText(r) },
  { key: 'rate', label: '$/sf/yr', num: true, get: (r) => rateOf(r), text: (r) => fmtRate(rateOf(r)) },
  { key: 'additional_rent', label: 'Add’l rent', num: true, get: (r) => r.additional_rent, text: (r) => fmtRate(r.additional_rent) },
  // Blank until a subject point is placed on the map (annotateDistance).
  { key: 'dist', label: 'km', num: true, get: (r) => r._dist ?? null, text: (r) => (r._dist == null ? '' : r._dist.toFixed(1)) },
  { key: 'status', label: 'Status', get: (r) => r.status || '', text: (r) => r.status || '' },
  // The day it went up — Moody's List Date, the broker's feed or the first
  // alert, whichever is earliest — and how long it was marketed from then.
  { key: 'listed', label: 'Listed', get: (r) => r.listed_date || '', text: (r) => dateText(r.listed_date, r.listed_date_source) },
  { key: 'days_on_market', label: 'Days', num: true, get: (r) => r.days_on_market, text: (r) => fmtInt(r.days_on_market) },
  // One column, not two. A conditional that came back reads "2024-04 → 2026-04",
  // which is the question being asked — it went conditional, did it stick? Two
  // sparse columns would cost twice the width to say the same thing, and
  // `relisted_date` alone is populated on 45 records out of 8,867.
  { key: 'conditional', label: 'Conditional', get: (r) => r.conditional_date || '', text: (r) => conditionalText(r) },
  { key: 'brokerage', label: 'Brokerage', get: (r) => r.brokerage || '', text: (r) => r.brokerage || '' },
  { key: 'first_seen', label: 'First seen', get: (r) => r.first_seen || '', text: (r) => r.first_seen || '' },
  { key: 'last_seen', label: 'Last seen', get: (r) => r.last_seen || '', text: (r) => r.last_seen || '' },
  { key: 'months_on_market', label: 'Months', num: true, get: (r) => r.months_on_market, text: (r) => fmtInt(r.months_on_market) },
  { key: 'zoning', label: 'Zoning', get: (r) => r.zoning || '', text: (r) => r.zoning || '' },
  // The assessment roll: a public identifier you can paste into the
  // assessor's own site, and what the N1 cross-reference now matches on.
  // Last because it is a reference to copy, not a figure to scan — and
  // it reads better through the search box than down a column.
  { key: 'roll', label: 'Roll', get: (r) => r.roll_number || '', text: (r) => rollText(r) },
]);

export const COLUMN_KEYS = Object.freeze(COLUMNS.map((c) => c.key));

// Moody's own page for a property. The scraper reads `moodys_id` out of the
// grid's /marketplace/property/{id} links, and on the 2026-09-20 snapshot
// all 874 rows round-trip exactly, so this is the page the id came from.
export const MOODYS_PROPERTY_URL = 'https://www.moodyscre.com/marketplace/property/';
// The members site's view of one LISTING: /property/{moodys_id}/{public_id}.
// public_id is the listing's 24-hex id from the detail page; older pages
// gave a numeric Listing ID there instead, which this URL does not take.
export const MOODYS_MEMBERS_URL = 'https://members.moodyscre.com/property/';
const MOODYS_ID = /^[a-f0-9]{16,40}$/;
const MOODYS_PUBLIC_ID = /^[a-f0-9]{24}$/;

/**
 * The documents a row can open, in the order the Links cell shows them.
 *
 * A flyer and a snapshot are files in the connected folder, opened in the
 * page; the Moody's link leaves for their site, under your own login. The
 * id is checked against the shape the scraper extracts before it goes
 * anywhere near an href — it arrives from a CSV in a shared folder, and a
 * value that is not a Moody's id has no business becoming a link.
 */
export function linksOf(r) {
  const out = [];
  if (r?.flyer_path) out.push({ kind: 'flyer', label: 'Flyer', title: r.flyer_path });
  const snaps = snapshotsOf(r);
  if (snaps.length) {
    out.push({ kind: 'snapshot', label: snaps.length > 1 ? `Snapshots (${snaps.length})` : 'Snapshot',
      title: snaps.map((s) => s.label).join(' · ') });
  }
  const id = String(r?.moodys_id ?? '').trim().toLowerCase();
  if (MOODYS_ID.test(id)) {
    const listing = String(r?.moodys_public_id ?? '').trim().toLowerCase();
    out.push(MOODYS_PUBLIC_ID.test(listing)
      ? { kind: 'moodys', label: "Moody's", href: `${MOODYS_MEMBERS_URL}${id}/${listing}`,
        title: 'Open this listing on the Moody’s members site (needs your login)' }
      : { kind: 'moodys', label: "Moody's", href: MOODYS_PROPERTY_URL + id,
        title: 'Open this property on Moody’s' });
  }
  return out;
}

/** Stable sort by a column key. Blanks sort last in either direction —
 *  an unpriced listing is not "cheapest". */
export function sortRows(rows, key, dir = 'asc') {
  const col = COLUMNS.find((c) => c.key === key);
  if (!col) return rows.slice();
  const sign = dir === 'desc' ? -1 : 1;
  const decorated = rows.map((r, i) => ({ r, i, v: col.get(r) }));
  decorated.sort((a, b) => {
    const an = a.v == null || a.v === '', bn = b.v == null || b.v === '';
    if (an && bn) return a.i - b.i;
    if (an) return 1;
    if (bn) return -1;
    const c = col.num
      ? Number(a.v) - Number(b.v)
      : String(a.v).localeCompare(String(b.v), 'en', { numeric: true, sensitivity: 'base' });
    return c !== 0 ? c * sign : a.i - b.i;
  });
  return decorated.map((d) => d.r);
}

/** One page of rows, 1-indexed page number. */
export function pageOf(rows, page, pageSize) {
  if (!pageSize || pageSize <= 0) return rows;
  const start = Math.max(0, (page - 1) * pageSize);
  return rows.slice(start, start + pageSize);
}

export const pageCount = (total, pageSize) =>
  (!pageSize || pageSize <= 0 ? 1 : Math.max(1, Math.ceil(total / pageSize)));

/**
 * The line under the grid: how many, and the medians that survive the
 * manifest's plausibility bands. Lease rates and sale prices are counted
 * separately — they are different measures in different units, and a
 * single "median asking" over both would be meaningless.
 */
export function summarize(rows, manifest) {
  const bands = policy(manifest);
  const rate = guardedMedian(rows.map(rateOf), bands.leaseRate);
  const price = guardedMedian(rows.map(priceOf), bands.salePrice);
  const size = guardedMedian(rows.map(sizeOf), bands.size);
  const lease = rows.filter((r) => r.listing_type === 'Lease').length;
  const sale = rows.filter((r) => r.listing_type === 'Sale').length;
  return {
    total: rows.length,
    lease,
    sale,
    medianRate: rate.n >= bands.minN ? rate.value : null,
    medianPrice: price.n >= bands.minN ? price.value : null,
    medianSize: size.n >= bands.minN ? size.value : null,
    pricedLease: rate.n,
    pricedSale: price.n,
    excluded: rate.excluded + price.excluded + size.excluded,
    withFlyer: rows.filter((r) => r.flyer_path).length,
    mapped: rows.filter((r) => r.latitude != null && r.longitude != null).length,
  };
}

/** A sentence for the count line. */
export function countLine(stats) {
  const n = stats.total.toLocaleString('en-CA');
  const bits = [`${n} listing${stats.total === 1 ? '' : 's'}`];
  if (stats.lease) bits.push(`${stats.lease.toLocaleString('en-CA')} lease`);
  if (stats.sale) bits.push(`${stats.sale.toLocaleString('en-CA')} sale`);
  return bits.join(' · ');
}

/** A second line: the medians, each with the n behind it. */
export function medianLine(stats) {
  const parts = [];
  if (stats.medianRate != null) {
    parts.push(`median rate ${fmtRate(stats.medianRate)}/sf/yr (n=${stats.pricedLease})`);
  }
  if (stats.medianPrice != null) {
    parts.push(`median price ${fmtMoney(stats.medianPrice)} (n=${stats.pricedSale})`);
  }
  if (stats.medianSize != null) parts.push(`median size ${fmtInt(stats.medianSize)} sf`);
  if (stats.excluded) parts.push(`${stats.excluded} implausible value${stats.excluded === 1 ? '' : 's'} excluded`);
  return parts.join(' · ');
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The grid as CSV, in the order and formatting on screen, with the
 * filter description carried in a leading comment line so a spreadsheet
 * found six months later still says what it is.
 */
export function toCsv(rows, { columns = COLUMNS, chips = [], published = null } = {}) {
  const lines = [];
  const provenance = [
    published ? `Published ${published}` : null,
    ...chips.map((c) => c.label),
  ].filter(Boolean).join(' | ');
  if (provenance) lines.push(`# ${provenance.replace(/[\r\n]+/g, ' ')}`);
  lines.push(columns.map((c) => csvCell(c.label)).join(','));
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.text(r))).join(','));
  return lines.join('\r\n') + '\r\n';
}
