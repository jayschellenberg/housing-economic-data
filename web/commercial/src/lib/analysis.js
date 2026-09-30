/*
 * analysis.js — the measures behind the Analysis tab. Pure; tested under
 * node. analysis.js (the view, one level up) renders these with
 * Observable Plot.
 *
 * WHAT THE HISTORY CAN AND CANNOT SAY. pass2_build records CHANGE
 * POINTS, and export_web turns them into closed [from, to] runs. So for
 * any cycle we can say what value a listing showed then — that is
 * exactly the rule the trends need: "a listing counts in a period it was
 * on the market in, at the value it showed then". What the history
 * cannot say is how many sources reported it that month; there is no
 * observation count to weight by, and none of these measures pretends
 * there is.
 *
 * Only psf_annual price runs feed a RATE series. A monthly total for a
 * whole yard is a real quote but not a rate, and 119 of the 8,677 price
 * runs carry one; converting them would need a size the tracker often
 * does not have for land. They are counted as unpriced rather than
 * guessed at.
 */

import { onMarketStatuses, policy, median, inBand, guardedMedian } from './summary.js';
import { BAND_ORDER, bandOf } from './bands.js';

const ymOrd = (ym) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
};
const ordYm = (n) => `${String(Math.floor(n / 12)).padStart(4, '0')}-${String((n % 12) + 1).padStart(2, '0')}`;

/** Every cycle month from `from` to `to`, inclusive. */
export function cyclesIn(from, to) {
  const a = ymOrd(from), b = ymOrd(to);
  if (a == null || b == null || b < a) return [];
  const out = [];
  for (let n = a; n <= b; n++) out.push(ordYm(n));
  return out;
}

/** The period a cycle belongs to at the requested granularity. */
export function bucketOf(cycle, granularity) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(cycle || ''));
  if (!m) return null;
  const [, year, month] = m;
  if (granularity === 'year') return year;
  if (granularity === 'quarter') return `${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}`;
  return `${year}-${month}`;
}

/** listing_id → { price: [run], status: [run] }, each ordered by `from`. */
export function indexRuns(runs) {
  const byId = new Map();
  for (const run of runs || []) {
    let entry = byId.get(run.listing_id);
    if (!entry) { entry = { price: [], status: [] }; byId.set(run.listing_id, entry); }
    (run.kind === 'price' ? entry.price : entry.status).push(run);
  }
  for (const entry of byId.values()) {
    entry.price.sort((a, b) => String(a.from).localeCompare(String(b.from)));
    entry.status.sort((a, b) => String(a.from).localeCompare(String(b.from)));
  }
  return byId;
}

/** The run covering `cycle`, or null. Runs are closed [from, to]. */
export function runAt(runs, cycle) {
  for (const run of runs || []) {
    if (run.from <= cycle && cycle <= run.to) return run;
  }
  return null;
}

/**
 * The market, cycle by cycle: how much was on it, and what it asked.
 *
 * Returns one row per bucket at the requested granularity, plus the same
 * split by space type. A listing counts in every cycle its status run
 * says it was on the market, at whatever rate its price run showed then.
 */
export function marketByCycle(records, runs, manifest, {
  granularity = 'month', from = null, to = null,
} = {}) {
  const statuses = onMarketStatuses(manifest);
  const bands = policy(manifest);
  const first = from || manifest?.cycles?.first;
  const last = to || manifest?.cycles?.last;
  const cycles = cyclesIn(first, last);
  if (!cycles.length) return [];

  const index = indexRuns(runs);
  // bucket -> { cycles:Set, onMarket, rates[], prices[], bands:Map }
  const buckets = new Map();
  const bucketFor = (key) => {
    let b = buckets.get(key);
    if (!b) {
      b = {
        bucket: key, cycles: new Set(), onMarket: 0, rates: [], prices: [],
        bands: new Map(), brokerages: new Set(),
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const rec of records || []) {
    const entry = index.get(rec.listing_id);
    if (!entry) continue;
    const band = bandOf(rec);
    for (const statusRun of entry.status) {
      if (!statuses.has(String(statusRun.value || '').toLowerCase())) continue;
      for (const cycle of cyclesIn(
        statusRun.from < first ? first : statusRun.from,
        statusRun.to > last ? last : statusRun.to,
      )) {
        const b = bucketFor(bucketOf(cycle, granularity));
        b.cycles.add(cycle);
        b.onMarket += 1;
        // Who was contributing that period. The tracker grew from one
        // brokerage in 2018 to ten in 2026, so a rising listing count is
        // partly coverage, not market. Carried so the chart can say so
        // instead of letting the reader assume growth.
        if (rec.brokerage) b.brokerages.add(rec.brokerage);
        let byBand = b.bands.get(band);
        if (!byBand) { byBand = { onMarket: 0, rates: [] }; b.bands.set(band, byBand); }
        byBand.onMarket += 1;

        const priceRun = runAt(entry.price, cycle);
        if (!priceRun || priceRun.value == null) continue;
        if (rec.listing_type === 'Lease' && priceRun.basis === 'psf_annual') {
          if (inBand(priceRun.value, bands.leaseRate)) {
            b.rates.push(priceRun.value);
            byBand.rates.push(priceRun.value);
          }
        } else if (rec.listing_type === 'Sale' && priceRun.basis === 'sale') {
          if (inBand(priceRun.value, bands.salePrice)) b.prices.push(priceRun.value);
        }
      }
    }
  }

  return [...buckets.values()]
    .map((b) => {
      const n = b.cycles.size || 1;   // months averaged over, for a quarter/year
      return {
        bucket: b.bucket,
        // On-market is a stock, not a flow: over a quarter, report the
        // average month rather than the sum of three months' listings.
        onMarket: Math.round(b.onMarket / n),
        brokerages: b.brokerages.size,
        medianRate: b.rates.length >= bands.minN ? median(b.rates) : null,
        medianPrice: b.prices.length >= bands.minN ? median(b.prices) : null,
        ratedN: b.rates.length,
        pricedN: b.prices.length,
        bands: [...b.bands.entries()]
          .map(([band, v]) => ({
            band,
            onMarket: Math.round(v.onMarket / n),
            medianRate: v.rates.length >= bands.minN ? median(v.rates) : null,
            n: v.rates.length,
          }))
          .sort((x, y) => BAND_ORDER.indexOf(x.band) - BAND_ORDER.indexOf(y.band)),
      };
    })
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/**
 * How much of a change in the listing count is coverage rather than
 * market. Returns null when coverage was flat across the window, which
 * is when the count can be read at face value.
 */
export function coverageNote(byCycle) {
  const rows = (byCycle || []).filter((r) => r.brokerages > 0);
  if (rows.length < 2) return null;
  const first = rows[0], last = rows[rows.length - 1];
  if (first.brokerages === last.brokerages) return null;
  return {
    from: first.bucket, to: last.bucket,
    fromCount: first.brokerages, toCount: last.brokerages,
  };
}

/** Long-form rows for a per-space-type line chart. */
export function bandSeries(byCycle, measure = 'medianRate') {
  const out = [];
  for (const row of byCycle) {
    for (const b of row.bands) {
      const value = measure === 'onMarket' ? b.onMarket : b.medianRate;
      if (value == null) continue;
      out.push({ bucket: row.bucket, band: b.band, value, n: b.n });
    }
  }
  return out;
}

/**
 * A table by geography, with the min-n suppression the bundle asks for.
 * A market of two listings has no median worth publishing; the row still
 * appears with its count, so nobody wonders where it went.
 */
export function byMarket(records, manifest, field = 'municipality') {
  const bands = policy(manifest);
  const groups = new Map();
  for (const r of records || []) {
    const key = r[field] || 'Unassigned';
    let g = groups.get(key);
    if (!g) { g = { name: key, total: 0, lease: 0, sale: 0, rates: [], prices: [], sizes: [] }; groups.set(key, g); }
    g.total += 1;
    if (r.listing_type === 'Lease') {
      g.lease += 1;
      if (r.current_price_psf_annual != null) g.rates.push(r.current_price_psf_annual);
    } else if (r.listing_type === 'Sale') {
      g.sale += 1;
      if (r.current_price != null) g.prices.push(r.current_price);
    }
    const size = r.sf_max ?? r.sf_min;
    if (size != null) g.sizes.push(size);
  }
  return [...groups.values()]
    .map((g) => {
      const rate = guardedMedian(g.rates, bands.leaseRate);
      const price = guardedMedian(g.prices, bands.salePrice);
      const size = guardedMedian(g.sizes, bands.size);
      return {
        name: g.name,
        total: g.total, lease: g.lease, sale: g.sale,
        medianRate: rate.n >= bands.minN ? rate.value : null,
        medianPrice: price.n >= bands.minN ? price.value : null,
        medianSize: size.n >= bands.minN ? size.value : null,
        ratedN: rate.n, pricedN: price.n,
        suppressed: rate.n > 0 && rate.n < bands.minN,
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Equal-width bins over `values`, for a histogram. */
export function distribution(values, { bins = 20, band = null } = {}) {
  const nums = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v) && inBand(v, band));
  if (!nums.length) return [];
  const lo = Math.min(...nums), hi = Math.max(...nums);
  if (lo === hi) return [{ x0: lo, x1: lo, n: nums.length }];
  const width = (hi - lo) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ x0: lo + i * width, x1: lo + (i + 1) * width, n: 0 }));
  for (const v of nums) {
    const i = Math.min(bins - 1, Math.floor((v - lo) / width));
    out[i].n += 1;
  }
  return out;
}

/**
 * How often an asking price moved, and by how much. Only listings with
 * more than one price run can have changed; the rest are the
 * denominator, not missing data.
 */
export function priceChanges(records, runs, manifest) {
  const bands = policy(manifest);
  const index = indexRuns(runs);
  let withHistory = 0, changed = 0, cuts = 0, raises = 0;
  const pct = [];
  for (const rec of records || []) {
    const price = (index.get(rec.listing_id)?.price || [])
      .filter((r) => r.value != null && r.basis === (rec.listing_type === 'Sale' ? 'sale' : 'psf_annual'));
    if (!price.length) continue;
    const band = rec.listing_type === 'Sale' ? bands.salePrice : bands.leaseRate;
    const usable = price.filter((r) => inBand(r.value, band));
    if (!usable.length) continue;
    withHistory += 1;
    if (usable.length < 2) continue;
    const firstV = usable[0].value, lastV = usable[usable.length - 1].value;
    if (firstV === lastV) continue;
    changed += 1;
    if (lastV < firstV) cuts += 1; else raises += 1;
    pct.push(((lastV - firstV) / firstV) * 100);
  }
  return {
    withHistory,
    changed,
    cuts,
    raises,
    shareChanged: withHistory ? changed / withHistory : 0,
    medianChangePct: pct.length >= bands.minN ? median(pct) : null,
  };
}

/** Months on market: the median, and the distribution for a histogram. */
export function timeOnMarket(records) {
  const months = (records || [])
    .map((r) => r.months_on_market)
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return {
    n: months.length,
    median: median(months),
    distribution: distribution(months, { bins: 12 }),
  };
}

/** Rate against size, for a scatter. Both axes must be plausible or one
 *  mislabelled yard rent stretches the chart flat. */
export function rateVsSize(records, manifest) {
  const bands = policy(manifest);
  const out = [];
  for (const r of records || []) {
    if (r.listing_type !== 'Lease') continue;
    const rate = r.current_price_psf_annual;
    const size = r.sf_max ?? r.sf_min;
    if (rate == null || size == null) continue;
    if (!inBand(rate, bands.leaseRate) || !inBand(size, bands.size)) continue;
    out.push({ size, rate, band: bandOf(r), address: r.address || r.property_name || '' });
  }
  return out;
}
