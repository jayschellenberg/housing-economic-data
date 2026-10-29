/*
 * Index arithmetic behind the Construction Cost and Commercial Leasing
 * indexing tools: put every index on a quarterly footing, chain a short
 * local series onto a longer proxy, and read a year (annual average) or a
 * single quarter off the result.
 *
 * Kept free of DOM so it can be tested directly (test/index-tool-math.test.js).
 * Records are { date: 'YYYY-MM-DD', value } as they sit in the indicator
 * shards; a quarter is keyed by its first month ('2017-01', '2017-04', …).
 */

const quarterKey = (iso) => {
  const y = iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}`;
};

/**
 * One value per quarter, sorted. Quarterly series pass through; monthly
 * series (CPI, NHPI) are averaged over the quarter's three months, and a
 * quarter still missing a month is dropped — so the newest quarter of a
 * monthly series is the newest COMPLETE one, never a one- or two-month
 * average passed off as the quarter.
 *
 * @param {Array<{date:string, value:number}>} records
 * @returns {Array<{q:string, value:number}>}
 */
export function toQuarterly(records) {
  const buckets = new Map();
  for (const r of records || []) {
    if (!Number.isFinite(r?.value) || !r.date) continue;
    const k = quarterKey(r.date);
    const b = buckets.get(k) || { months: new Set(), sum: 0, n: 0 };
    b.months.add(r.date.slice(0, 7));
    b.sum += r.value;
    b.n += 1;
    buckets.set(k, b);
  }
  // Monthly if any quarter carries more than one month; a quarterly series
  // has exactly one observation per quarter.
  const monthly = [...buckets.values()].some((b) => b.months.size > 1);
  return [...buckets.entries()]
    .filter(([, b]) => !monthly || b.months.size === 3)
    .map(([q, b]) => ({ q, value: b.sum / b.n }))
    .sort((a, b) => a.q.localeCompare(b.q));
}

/**
 * Chain `primary` onto `proxy` so the proxy carries the history the primary
 * lacks. At the primary's first quarter (the link) the proxy is rescaled to
 * the primary's level; before it, each quarter is proxy × (primary ÷ proxy at
 * the link), so the proxy contributes only its movement, never its level.
 * From the link on, the primary is used as published.
 *
 * Returns the primary unchanged (linkQ null) when there is no proxy or the
 * proxy has no value at the link quarter.
 *
 * @param {Array<{q:string, value:number}>} primary  quarterly
 * @param {Array<{q:string, value:number}>|null} proxy quarterly
 * @returns {{ series: Array<{q:string, value:number, spliced?:boolean}>, linkQ: string|null }}
 */
export function chain(primary, proxy) {
  if (!primary?.length) return { series: [], linkQ: null };
  const linkQ = primary[0].q;
  const atLink = (proxy || []).find((p) => p.q === linkQ);
  if (!atLink || !(atLink.value > 0)) return { series: primary.slice(), linkQ: null };
  const factor = primary[0].value / atLink.value;
  const back = proxy
    .filter((p) => p.q < linkQ)
    .map((p) => ({ q: p.q, value: p.value * factor, spliced: true }));
  return { series: [...back, ...primary], linkQ };
}

/**
 * Average of two quarterly series over the quarters both publish — the
 * "Prairie average" proxy (Calgary + Edmonton, both on 2023=100).
 *
 * @param {Array<{q:string, value:number}>} a
 * @param {Array<{q:string, value:number}>} b
 */
export function averageSeries(a, b) {
  const byQ = new Map((b || []).map((p) => [p.q, p.value]));
  return (a || []).filter((p) => byQ.has(p.q)).map((p) => ({ q: p.q, value: (p.value + byQ.get(p.q)) / 2 }));
}

/**
 * The index for a year (average of its published quarters) or a single
 * quarter (1–4). `partial` flags a year averaged over fewer than four
 * quarters — the current year, or the series' first year. `spliced` is true
 * when any quarter used came from the proxy.
 *
 * @param {Array<{q:string, value:number, spliced?:boolean}>} series
 * @param {number} year
 * @param {number|null} quarter
 * @returns {null|{ value:number, quarters:string[], partial:boolean, spliced:boolean }}
 */
export function periodIndex(series, year, quarter) {
  const want = quarter
    ? [`${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}`]
    : ['01', '04', '07', '10'].map((m) => `${year}-${m}`);
  const hits = (series || []).filter((p) => want.includes(p.q));
  if (!hits.length) return null;
  return {
    value: hits.reduce((s, p) => s + p.value, 0) / hits.length,
    quarters: hits.map((p) => p.q),
    partial: !quarter && hits.length < 4,
    spliced: hits.some((p) => p.spliced),
  };
}

/** "2017-04" → "Q2 2017". */
export function fmtQuarter(q) {
  const m = +q.slice(5, 7);
  return `Q${Math.floor((m - 1) / 3) + 1} ${q.slice(0, 4)}`;
}

/**
 * Index an amount from a base period to the newest quarter of `series`.
 * Returns null when the base period isn't covered.
 *
 * @param {Array<{q:string, value:number, spliced?:boolean}>} series
 * @param {number} amount
 * @param {number} year
 * @param {number|null} quarter
 */
export function indexToCurrent(series, amount, year, quarter) {
  const base = periodIndex(series, year, quarter);
  if (!base || !series.length) return null;
  const cur = series[series.length - 1];
  const factor = cur.value / base.value;
  // Years between the middle of the base period and the current quarter, for
  // the compound annual rate.
  const mid = (q) => +q.slice(0, 4) + (+q.slice(5, 7) - 1 + 1.5) / 12;
  const baseMid = base.quarters.reduce((s, q) => s + mid(q), 0) / base.quarters.length;
  const years = mid(cur.q) - baseMid;
  return {
    base,
    current: { q: cur.q, value: cur.value },
    factor,
    pct: (factor - 1) * 100,
    cagr: years >= 1 ? (factor ** (1 / years) - 1) * 100 : null,
    indexed: Number.isFinite(amount) ? amount * factor : null,
  };
}
