/*
 * summary.js — what the overview shows, as pure functions over the parsed
 * bundle. No DOM, so node tests cover the arithmetic; summaryView.js does
 * the rendering.
 *
 * "CURRENT" IS A DATA QUESTION, NOT A CLOCK QUESTION. A listing counts as
 * on the market now when its status is one the bundle names as on-market
 * AND it was seen in the newest cycle the bundle carries. Measuring
 * against today's date instead would shrink the market every day an
 * unrefreshed folder sat on someone's laptop.
 */

/** Statuses the bundle calls on-market, lower-cased. */
export function onMarketStatuses(manifest) {
  const list = manifest?.on_market_statuses;
  return new Set((Array.isArray(list) ? list : []).map((s) => String(s).toLowerCase()));
}

/** Seen in the newest cycle, with a status that is still on the market. */
export function isCurrent(rec, manifest, statuses = onMarketStatuses(manifest)) {
  const cycle = manifest?.cycles?.last;
  if (!cycle || rec.last_seen !== cycle) return false;
  return statuses.has(String(rec.status || '').toLowerCase());
}

export function currentRecords(records, manifest) {
  const statuses = onMarketStatuses(manifest);
  return records.filter((r) => isCurrent(r, manifest, statuses));
}

/**
 * The plausibility bands the bundle ships (manifest.policy). One
 * definition, every surface — and never a cutoff this build invented.
 */
export function policy(manifest) {
  const p = manifest?.policy || {};
  return {
    leaseRate: p.lease_rate_band || null,
    salePrice: p.sale_price_band || null,
    size: p.size_band_sf || null,
    minN: p.min_n ?? 1,
  };
}

/** Inside the band, or true when there is no band to judge by. */
export function inBand(value, band) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (!Array.isArray(band) || band.length !== 2) return true;
  return value >= band[0] && value <= band[1];
}

/**
 * Median of the values that fall inside `band`, plus how many were
 * dropped. An out-of-band value is a data problem upstream (a monthly
 * total mislabelled as a rate, say); it stays visible on the record and
 * is reported here, never silently averaged in.
 */
export function guardedMedian(values, band) {
  const usable = [], dropped = [];
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    (inBand(v, band) ? usable : dropped).push(v);
  }
  return { value: median(usable), n: usable.length, excluded: dropped.length };
}

export function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = nums.length >> 1;
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Rows for the "what's on the market" table: one per space type, split by
 * listing type, with the median asking measure for each.
 *
 * The two listing types are not one number. A lease is quoted in $/sf/yr
 * and a sale in dollars, so they get their own columns and are never
 * averaged together — current_price_psf_annual is only meaningful where
 * the basis is a rate.
 */
export function bySpaceType(records, manifest) {
  const current = currentRecords(records, manifest);
  const bands = policy(manifest);
  const buckets = new Map();
  for (const r of current) {
    const key = r.space_type || 'Unspecified';
    if (!buckets.has(key)) buckets.set(key, { lease: [], sale: [] });
    const b = buckets.get(key);
    if (r.listing_type === 'Lease') {
      b.lease.push(r);
    } else if (r.listing_type === 'Sale') {
      b.sale.push(r);
    }
  }
  const rows = [...buckets.entries()].map(([space_type, b]) => {
    const rate = guardedMedian(b.lease.map((r) => r.current_price_psf_annual), bands.leaseRate);
    const price = guardedMedian(b.sale.map((r) => r.current_price), bands.salePrice);
    const size = guardedMedian([...b.lease, ...b.sale].map((r) => r.sf_max ?? r.sf_min), bands.size);
    return {
      space_type,
      lease: b.lease.length,
      sale: b.sale.length,
      total: b.lease.length + b.sale.length,
      median_rate: rate.n >= bands.minN ? rate.value : null,
      median_price: price.n >= bands.minN ? price.value : null,
      median_sf: size.n >= bands.minN ? size.value : null,
      priced_lease: rate.n,
      priced_sale: price.n,
      excluded: rate.excluded + price.excluded + size.excluded,
    };
  });
  rows.sort((a, b) => b.total - a.total || a.space_type.localeCompare(b.space_type));
  return rows;
}

/** How many current listings carry a value no aggregate will accept.
 *  Surfaced in the UI so an upstream extraction error gets noticed. */
export function excludedCount(records, manifest) {
  return bySpaceType(records, manifest).reduce((n, r) => n + r.excluded, 0);
}

/** One row per brokerage: everything they have ever listed, and what is
 *  on the market now. */
export function byBrokerage(records, manifest) {
  const statuses = onMarketStatuses(manifest);
  const buckets = new Map();
  for (const r of records) {
    const key = r.brokerage || 'Unattributed';
    if (!buckets.has(key)) buckets.set(key, { brokerage: key, records: 0, current: 0 });
    const b = buckets.get(key);
    b.records += 1;
    if (isCurrent(r, manifest, statuses)) b.current += 1;
  }
  return [...buckets.values()].sort((a, b) => b.current - a.current || b.records - a.records);
}

/** Top municipalities by what is on the market now. */
export function byMunicipality(records, manifest, limit = 10) {
  const buckets = new Map();
  for (const r of currentRecords(records, manifest)) {
    const key = r.municipality || 'Unassigned';
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return [...buckets.entries()]
    .map(([municipality, current]) => ({ municipality, current }))
    .sort((a, b) => b.current - a.current || a.municipality.localeCompare(b.municipality))
    .slice(0, limit);
}

/** Headline tiles. Percentages are of the whole bundle, not of the
 *  current market — they describe the data, not the inventory. */
export function headline(records, manifest) {
  const c = manifest?.counts || {};
  const current = currentRecords(records, manifest);
  return {
    records: records.length,
    current: current.length,
    cycleFirst: manifest?.cycles?.first || null,
    cycleLast: manifest?.cycles?.last || null,
    cycleCount: manifest?.cycles?.count || 0,
    geocoded: c.with_coords ?? records.filter((r) => r.latitude != null && r.longitude != null).length,
    flyersPresent: manifest?.flyers?.present ?? 0,
    duplicateSpaces: c.duplicate_spaces ?? 0,
    runs: c.runs ?? 0,
  };
}
