/*
 * apartment-comps-data.js — the pure half of the Apartment Comps tab: what a
 * record's income and expense figures are, how they are normalized (per
 * suite, share of EGI) and how the filtered set is summarized. No DOM.
 *
 * Records come from scripts/apartment_comps.py (apartment_comps.json). Each
 * is either a row of the appraiser's comps database (src 'db') or one
 * scenario of an extracted listing / pro forma / CIM (src 'doc'). Income and
 * expense figures are annual dollars keyed by category: { v, a? } where `a`
 * marks the appraiser's own allowance (=700*units, =EGI*7%) rather than a
 * reported figure.
 */

export const INCOME_LABELS = {
  rent: 'Gross rent', parking: 'Parking', laundry: 'Laundry',
  other_income: 'Other income', vacancy: 'Vacancy & bad debt',
};

export const EXPENSE_LABELS = {
  tax: 'Property tax', insurance: 'Insurance', hydro: 'Electricity (hydro)',
  water: 'Water & sewer', gas_heat: 'Gas / heat', heat_hydro: 'Heat + hydro (combined)',
  elec_water: 'Hydro + water (combined)', utilities: 'Utilities (combined)',
  rm: 'Repairs & maintenance', payroll: 'Caretaker / payroll', mgmt: 'Management',
  snow_yard: 'Snow & yard', elevator: 'Elevator', fire_life: 'Fire / life safety',
  garbage: 'Garbage', admin: 'Admin / professional', garb_admin: 'Garbage + admin (combined)',
  reserve: 'Reserve', other: 'Other',
};

export const UTILITY_CATS = ['hydro', 'water', 'gas_heat', 'heat_hydro', 'elec_water', 'utilities'];

/** The expense columns of the table and summary; each sums its categories. */
export const COLUMNS = [
  { id: 'tax', label: 'Tax', cats: ['tax'] },
  { id: 'insurance', label: 'Insurance', cats: ['insurance'] },
  { id: 'hydro', label: 'Hydro', cats: ['hydro'] },
  { id: 'water', label: 'Water', cats: ['water'] },
  { id: 'gas_heat', label: 'Gas / heat', cats: ['gas_heat'] },
  { id: 'util_comb', label: 'Utilities combined', cats: ['heat_hydro', 'elec_water', 'utilities'],
    title: 'A line that combines utilities (heat + hydro, hydro + water, or all utilities)' },
  { id: 'rm', label: 'R&M', cats: ['rm'] },
  { id: 'payroll', label: 'Payroll', cats: ['payroll'] },
  { id: 'mgmt', label: 'Mgmt', cats: ['mgmt'] },
  { id: 'other', label: 'Other', cats: ['snow_yard', 'elevator', 'fire_life', 'garbage', 'admin', 'garb_admin', 'reserve', 'other'],
    title: 'Snow & yard, elevator, fire / life safety, garbage, admin, reserve and other' },
];
const ALL_EXPENSE_CATS = Object.keys(EXPENSE_LABELS);

/** Record kinds grouped for the filter: DB transaction types and document types. */
export const KIND_GROUPS = [
  { id: 'sale', label: 'Closed sales' },
  { id: 'listing', label: 'Listings & flyers' },
  { id: 'pro_forma', label: 'Pro formas' },
  { id: 'cim', label: 'CIMs (confidential)' },
  { id: 'income_statement', label: 'Income statements' },
  { id: 'appraised', label: 'Appraised' },
  { id: 'expired', label: 'Expired / withdrawn' },
  { id: 'other', label: 'Other' },
];

export function kindGroup(r) {
  const k = String(r.kind || '').toLowerCase();
  if (r.src === 'db') {
    if (k.startsWith('closed')) return 'sale';
    if (k.startsWith('listing') || k === 'active') return 'listing';
    if (k.startsWith('expired') || k.startsWith('withdrawn') || k.startsWith('terminated')) return 'expired';
    if (k === 'appraised') return 'appraised';
    return r.price_kind === 'sale' ? 'sale' : 'other';
  }
  if (k === 'listing' || k === 'flyer') return 'listing';
  if (k === 'pro_forma' || k === 'cim' || k === 'income_statement') return k;
  if (k === 'sale') return 'sale';
  return 'other';
}

export const KIND_LABEL = {
  sale: 'Sale', listing: 'Listing', pro_forma: 'Pro forma', cim: 'CIM',
  income_statement: 'Income stmt', appraised: 'Appraised', expired: 'Expired', other: 'Other',
};

export const PTYPE_LABELS = {
  apartment: 'Apartment', rooming: 'Rooming house', mixed: 'Mixed res-comm',
  townhouse: 'Townhouse', 'duplex-fourplex': 'Duplex to fourplex',
};

/** Projected figures (pro forma, future, stabilized) vs current / actual ones. */
export function isProjected(r) {
  const s = `${r.scenario || ''} ${r.period || ''}`.toLowerCase();
  if (!s.trim()) return r.kind === 'pro_forma';
  if (/actual|as-is|as is|current|present|in-place|in place/.test(s)) return false;
  return /pro ?forma|future|stabili|projected|potential|market|year 1|normalized/.test(s);
}

/** 'gas' | 'electric' | 'furnace' | 'other' | null from the free-text heat source. */
export function heatGroup(r) {
  const h = String(r.heat || '').toLowerCase();
  if (!h) return null;
  if (/furnace|individ/.test(h)) return 'furnace';
  if (/elec|baseboard/.test(h)) return 'electric';
  if (/gas|boiler/.test(h)) return 'gas';
  return 'other';
}
export const HEAT_LABELS = { gas: 'Gas / boiler', electric: 'Electric', furnace: 'Individual furnace', other: 'Other' };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** A category's annual dollars, or null; allowances only when `assumed`. */
export function catValue(r, cat, { assumed = false } = {}) {
  const e = r.exp?.[cat] ?? r.inc?.[cat];
  if (!e || !isNum(e.v)) return null;
  if (e.a && !assumed) return null;
  return e.v;
}

/** { v, assumed } summing a column's categories, or null when none present. */
export function columnValue(r, cats, opts = {}) {
  let v = null, assumed = false;
  for (const c of cats) {
    const x = catValue(r, c, opts);
    if (x == null) continue;
    v = (v ?? 0) + x;
    if (r.exp?.[c]?.a) assumed = true;
  }
  return v == null ? null : { v, assumed };
}

/** Effective gross income: stated EGI, else income lines less vacancy. */
export function egiOf(r, { assumed = false } = {}) {
  if (isNum(r.egi) && r.egi > 0) return r.egi;
  const inc = r.inc || {};
  let gross = 0, any = false;
  for (const k of ['rent', 'parking', 'laundry', 'other_income']) {
    if (isNum(inc[k]?.v)) { gross += inc[k].v; any = true; }
  }
  if (!any) return null;
  const vac = inc.vacancy && (!inc.vacancy.a || assumed) ? inc.vacancy.v : 0;
  return gross - (isNum(vac) ? vac : 0);
}

/** Sum of every expense category present (reported only unless `assumed`). */
export function totalExpenses(r, opts = {}) {
  return columnValue(r, ALL_EXPENSE_CATS, opts)?.v ?? null;
}

export function utilitiesTotal(r, opts = {}) {
  return columnValue(r, UTILITY_CATS, opts)?.v ?? null;
}

/**
 * Normalize annual dollars: 'annual' as is, 'suite' per suite per year,
 * 'egi' as a fraction of EGI. null when the base is missing.
 */
export function normalize(v, r, mode, opts = {}) {
  if (v == null) return null;
  if (mode === 'suite') return isNum(r.suites) && r.suites > 0 ? v / r.suites : null;
  if (mode === 'egi') {
    const egi = egiOf(r, opts);
    return egi && egi > 0 ? v / egi : null;
  }
  return v;
}

export function hasExpenses(r) {
  return Object.keys(r.exp || {}).length > 0;
}

const ymd = (d) => String(d || '');

/**
 * The address as the City of Winnipeg address index wants it: the first civic
 * number of a range ("1165-1167-1169 Alexander Ave", "300-318 Marion St",
 * "626/630 Jessie Ave" → "1165 Alexander Ave" …). null without a leading number.
 */
export function lookupAddressText(address) {
  const s = String(address || '')
    .replace(/\([^)]*\)/g, ' ')                // "(71 Lenore)", "(to be built)"
    .replace(/\s+&\s+.*$/, '')                // "175 Ruby St & 911 Westminster"
    .replace(/\s*-\s*appr\w*\.?\s*$/i, '')    // "270 St. John's Ave-APPRAISED"
    .replace(/\bCr\b\.?/i, 'Cres')            // the appraiser's "Cr" for Crescent
    .replace(/\s+/g, ' ')
    .trim();
  const m = s.match(/^(\d+)[A-Za-z]?(?:\s*[-/&,]\s*\d+[A-Za-z]?)*\s+(.*[A-Za-z].*)$/);
  return m ? `${m[1]} ${m[2]}` : null;
}

/** Label used for records the address index could not place. */
export const NO_CLUSTER = '(not matched)';

/**
 * @param {Array} records
 * @param {Object} f  { q, dateFrom, dateTo ('YYYY-MM'), yrFrom, yrTo, suitesMin,
 *   suitesMax, ptypes:Set, kinds:Set, projected:'all'|'actual'|'projected',
 *   heat:'' | heatGroup, pays:{hydro,heat,water:'any'|'Y'|'N'}, withExpenses,
 *   showConf, unchecked }
 */
export function filterRecords(records, f) {
  const q = String(f.q || '').trim().toLowerCase();
  return records.filter((r) => {
    if (r.conf && !f.showConf) return false;
    if (f.withExpenses && !hasExpenses(r)) return false;
    if (f.unchecked && !(r.src === 'doc' && !r.checked)) return false;
    if (q) {
      const hay = `${r.address || ''} ${r.other_addresses || ''} ${r.mls || ''} ${r.file || ''} ${r.notes || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const d = ymd(r.date);
    if (f.dateFrom && (!d || d.slice(0, 7) < f.dateFrom)) return false;
    if (f.dateTo && (!d || d.slice(0, 7) > f.dateTo)) return false;
    if (isNum(f.yrFrom) && !(isNum(r.yr) && r.yr >= f.yrFrom)) return false;
    if (isNum(f.yrTo) && !(isNum(r.yr) && r.yr <= f.yrTo)) return false;
    if (isNum(f.suitesMin) && !(isNum(r.suites) && r.suites >= f.suitesMin)) return false;
    if (isNum(f.suitesMax) && !(isNum(r.suites) && r.suites <= f.suitesMax)) return false;
    if (f.ptypes && !f.ptypes.has(r.ptype || 'apartment')) return false;
    if (f.clusters && !f.clusters.has(r.cluster || NO_CLUSTER)) return false;
    if (f.kinds && !f.kinds.has(kindGroup(r))) return false;
    if (f.projected === 'actual' && isProjected(r)) return false;
    if (f.projected === 'projected' && !isProjected(r)) return false;
    if (f.heat && heatGroup(r) !== f.heat) return false;
    for (const u of ['hydro', 'heat', 'water']) {
      const want = f.pays?.[u];
      if (want && want !== 'any' && r.pays?.[u] !== want) return false;
    }
    return true;
  });
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** { n, median, mean, min, max } of finite values, or n 0. */
export function stats(xs) {
  const v = xs.filter(isNum);
  if (!v.length) return { n: 0, median: null, mean: null, min: null, max: null };
  return {
    n: v.length, median: median(v), mean: v.reduce((a, b) => a + b, 0) / v.length,
    min: Math.min(...v), max: Math.max(...v),
  };
}

/** Summary rows for the filtered set under the chosen metric. */
export function summarize(records, { mode = 'suite', assumed = false } = {}) {
  const opts = { assumed };
  const row = (label, get, extra = {}) => ({
    label, ...extra,
    ...stats(records.map((r) => normalize(get(r), r, mode, opts))),
  });
  return [
    ...COLUMNS.map((c) => row(c.label, (r) => columnValue(r, c.cats, opts)?.v ?? null, { id: c.id })),
    row('All utilities', (r) => utilitiesTotal(r, opts), { id: 'utilities_all', strong: true }),
    row('Total expenses', (r) => totalExpenses(r, opts), { id: 'total', strong: true }),
    // Always a share of EGI, whatever the chosen metric.
    { label: 'Expense ratio (% of EGI)', id: 'ratio', strong: true, fmt: 'pct',
      ...stats(records.map((r) => expenseRatio(r, opts))) },
    { label: 'EGIM (price ÷ EGI)', id: 'egim', fmt: 'x', gap: true, ...stats(records.map((r) => egimOf(r, opts))) },
    { label: 'Cap rate', id: 'cap', fmt: 'pct', ...stats(records.map(capOf)) },
  ];
}

/**
 * NOI, or null when it means nothing: income with no expenses beside it (NOI
 * would just be EGI) or a NOI of zero or less. A document that states a NOI
 * with no line items at all keeps it.
 */
export function noiOf(r) {
  if (!isNum(r.noi) || r.noi <= 0) return null;
  const hasIncome = Object.keys(r.inc || {}).length > 0;
  if (hasIncome && !hasExpenses(r)) return null;
  return r.noi;
}

/** Cap rate as a fraction: the source's own, else NOI ÷ price; null with no usable NOI. */
export function capOf(r) {
  const noi = noiOf(r);
  if (noi == null) return null;
  if (isNum(r.cap) && r.cap > 0) return r.cap;
  const price = priceOf(r);
  return price ? noi / price : null;
}

/** Effective gross income multiplier: price ÷ EGI. */
export function egimOf(r, opts = {}) {
  const price = priceOf(r);
  const egi = egiOf(r, opts);
  return price && egi && egi > 0 ? price / egi : null;
}

/** Total expenses as a fraction of EGI, or null. */
export function expenseRatio(r, opts = {}) {
  const t = totalExpenses(r, opts);
  const e = egiOf(r, opts);
  return t != null && e && e > 0 ? t / e : null;
}

/** Other records of the same property (same address key), newest first. */
export function sameProperty(records, r) {
  if (!r.key) return [];
  return records.filter((x) => x.key === r.key && x.id !== r.id)
    .sort((a, b) => ymd(b.date).localeCompare(ymd(a.date)));
}

export function priceOf(r) {
  return isNum(r.price) ? r.price : null;
}

/** Sort key per table column id. */
export function sortValue(r, id, opts) {
  switch (id) {
    case 'date': return ymd(r.date);
    case 'address': return String(r.address || '').replace(/^[\d\s\-/]+/, '').toLowerCase() + ' ' + String(r.address || '');
    case 'kind': return kindGroup(r);
    case 'suites': return r.suites ?? null;
    case 'yr': return r.yr ?? null;
    case 'price': return priceOf(r);
    case 'per_suite': return priceOf(r) && r.suites ? priceOf(r) / r.suites : null;
    case 'egi': return egiOf(r, opts);
    case 'total': return normalize(totalExpenses(r, opts), r, opts.mode, opts);
    case 'cluster': return r.cluster ? r.cluster.toLowerCase() : null;
    case 'ratio': return expenseRatio(r, opts);
    case 'egim': return egimOf(r, opts);
    case 'noi': return noiOf(r);
    case 'cap': return capOf(r);
    default: {
      const c = COLUMNS.find((x) => x.id === id);
      return c ? normalize(columnValue(r, c.cats, opts)?.v ?? null, r, opts.mode, opts) : null;
    }
  }
}

export function sortRecords(records, id, dir, opts) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => {
    const x = sortValue(a, id, opts), y = sortValue(b, id, opts);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}
