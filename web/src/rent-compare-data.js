/*
 * rent-compare-data.js — pure helpers for the Rent Comparison tab: one rent
 * line per source for a centre and unit type, from
 *   Rentals.ca   average ASKING rent of listed units (monthly; rentalsca.json)
 *   Yardi        average IN-PLACE rent of sitting tenants (quarterly; yardi.json)
 *   CMHC         Rental Market Survey average rent, purpose-built APARTMENTS
 *                (October each year; the site's own series shards)
 * No DOM here (tested in test/rent-compare-data.test.js).
 */

import { qDate } from './yardi-data.js';

/** The centres all three sources cover: Yardi's 12 CMAs and Canada. */
export const CENTRES = [
  { id: 'Winnipeg', rc: 'Winnipeg', yardi: 'Winnipeg', cmhc: '602' },
  { id: 'Saskatoon', rc: 'Saskatoon', yardi: 'Saskatoon', cmhc: '725' },
  { id: 'Calgary', rc: 'Calgary', yardi: 'Calgary', cmhc: '825' },
  { id: 'Edmonton', rc: 'Edmonton', yardi: 'Edmonton', cmhc: '835' },
  { id: 'Vancouver', rc: 'Vancouver', yardi: 'Vancouver', cmhc: '933' },
  { id: 'Toronto', rc: 'Toronto', yardi: 'Toronto', cmhc: '535' },
  { id: 'Hamilton', rc: 'Hamilton', yardi: 'Hamilton', cmhc: '537' },
  // Rentals.ca lists Kitchener, Cambridge and Waterloo separately; Kitchener
  // is the largest. CMHC's Ottawa CMA part is the Ontario side.
  { id: 'Kitchener–Cambridge–Waterloo', rc: 'Kitchener', yardi: 'Kitchener–Cambridge–Waterloo', cmhc: '541' },
  { id: 'London', rc: 'London', yardi: 'London', cmhc: '555' },
  { id: 'Ottawa–Gatineau', rc: 'Ottawa', yardi: 'Ottawa–Gatineau', cmhc: '35505' },
  { id: 'Montreal', rc: 'Montreal', yardi: 'Montreal', cmhc: '462' },
  { id: 'Halifax', rc: 'Halifax', yardi: 'Halifax', cmhc: '205' },
  { id: 'Canada', rc: 'Canada', yardi: 'National', cmhc: null },
];

/** Unit types, bedrooms first and the all-units total last (CMHC order). */
export const UNITS = [
  { id: '0br', label: 'Studio', yardi: 'bachelor', cmhc: 'Studio' },
  { id: '1br', label: '1-Bedroom', yardi: '1br', cmhc: '1 Bedroom' },
  { id: '2br', label: '2-Bedroom', yardi: '2br', cmhc: '2 Bedroom' },
  { id: '3br', label: '3-Bedroom', yardi: '3br', cmhc: '3 Bedroom +' },
  { id: 'total', label: 'All units', yardi: 'total', cmhc: 'Total' },
];
export const DEFAULT_UNITS = ['1br', '2br', 'total'];

export const SOURCES = [
  { id: 'rc', label: 'Rentals.ca asking' },
  { id: 'yardi', label: 'Yardi in-place' },
  { id: 'cmhc', label: 'CMHC average (apartments)' },
];

/**
 * One source's rent points for a centre and unit: [{ date, value, src }],
 * oldest first. `src` is 't' (published), or 'c' / 'd' where the source file
 * marks a chart reading or an estimate.
 */
export function rentalsCaPoints(rc, centre, unit, seg = 'all') {
  if (!rc) return [];
  const isCanada = centre.rc === 'Canada';
  const level = isCanada ? (seg === 'ac' ? 'province' : 'national') : 'city';
  const s = isCanada && seg !== 'ac' ? 'all' : seg;
  // Rentals.ca publishes studio / 3-bed rents by province only.
  if (level === 'city' && (unit.id === '0br' || unit.id === '3br')) return [];
  return rc.obs
    .filter(r => r[1] === centre.rc && r[2] === level && r[3] === s && r[4] === unit.id && r[5] === 'rent' && Number.isFinite(r[6]))
    .map(r => ({ date: `${r[0]}-01`, value: r[6], src: r[7] }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function yardiPoints(yd, centre, unit) {
  if (!yd) return [];
  return yd.obs
    .filter(r => r[1] === centre.yardi && r[2] === unit.yardi && r[3] === 'rent' && Number.isFinite(r[4]))
    .map(r => ({ date: qDate(r[0]), value: r[4], src: r[5] }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** CMHC October average rent for purpose-built apartments, from a series shard. */
export function cmhcPoints(shard, unit) {
  if (!shard?.records) return [];
  return shard.records
    .filter(r => r.series === 'Average Rent' && r.dimension === 'Bedroom Type' && r.dwellingType === 'Apartment'
      && r.category === unit.cmhc && Number.isFinite(r.value))
    .map(r => ({ date: `${r.year}-10-01`, value: r.value, src: 't' }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Points on or after `from` ('YYYY-MM-DD'), or all of them. */
export const since = (pts, from) => (from ? pts.filter(p => p.date >= from) : pts);

/** "September 2026", "Q2 2026", "October 2025" for a source's point date. */
export function asOfLabel(sourceId, date) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (sourceId === 'yardi') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
