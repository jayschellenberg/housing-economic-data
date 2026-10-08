/*
 * Census narrative — turns a census_profile.json region (plus one or more
 * benchmark regions) into the ordered text blocks of an appraisal-report
 * "community profile" paragraph set: growth, income, dwelling values, housing
 * stock, and appraiser-note stubs. Pure functions, no DOM — census.js renders
 * the blocks on screen and hands the same blocks to exportNarrativeToWord.
 *
 * Phase 1 of docs/neighbourhood-narrative-plan.md: census-only, no new data.
 * Every sentence degrades gracefully — a missing value drops the sentence (or
 * the benchmark clause) rather than printing "**" into prose.
 *
 * The thresholds below are the whole "voice" of the tool; keep them in these
 * tables rather than inline so the wording stays repeatable across reports.
 */

import { miss, fInt, fUsd } from './format.js';

// Subject ÷ benchmark ratio → phrase. Ordered high → low; first match wins.
export const RATIO_LADDER = [
  { min: 1.25, phrase: 'well above' },
  { min: 1.10, phrase: 'above' },
  { min: 1.03, phrase: 'modestly above' },
  { min: 0.97, phrase: 'roughly in line with' },
  { min: 0.90, phrase: 'modestly below' },
  { min: 0.75, phrase: 'below' },
  { min: -Infinity, phrase: 'well below' },
];

// Latest inter-census population change (%) → trajectory word.
export const GROWTH_CLASSES = [
  { min: 10,        word: 'growing rapidly' },
  { min: 3,         word: 'growing' },
  { min: 1,         word: 'growing modestly' },
  { min: -1,        word: 'stable' },
  { min: -Infinity, word: 'contracting' },
];
// Subject minus benchmark (percentage points) → relative clause.
export const RELATIVE_BAND = 2;

// Structural-type keys → prose labels (plural, for "X% were apartments").
const TYPE_LABELS = {
  single_detached: 'single-detached houses',
  apt_lt5:         'apartments in buildings under five storeys',
  apt_ge5:         'apartments in buildings of five or more storeys',
  semi_detached:   'semi-detached houses',
  row_house:       'row houses',
  apt_duplex:      'duplex units',
  movable:         'movable dwellings',
  other_attached:  'other attached dwellings',
};
const APT_KEYS = ['apt_lt5', 'apt_ge5', 'apt_duplex'];
const BUILT_POST_2000 = ['built_2001_2005', 'built_2006_2010', 'built_2011_2015', 'built_2016_2021'];

const num = (v) => (miss(v) ? null : Number(v));
// Census zeros for population/households mean "not published" (e.g. Steinbach
// CA 2011), never a real empty area — treat them as missing too.
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };

export const ratioPhrase = (ratio) => RATIO_LADDER.find(l => ratio >= l.min).phrase;
export const growthWord  = (pct)   => GROWTH_CLASSES.find(g => pct >= g.min).word;

const fPct1s = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;   // signed, typographic minus
const fPct0  = (v) => `${Math.round(v)}%`;

// The income reference year is the census year minus one.
const incomeYear = (period) => ({ '2021': '2020', '2016': '2015', '2011': '2010' }[period] || period);

// Prose-friendly area name: drop cleanName()'s census type suffix ("Steinbach
// (CY)" → "Steinbach") but keep the metro qualifier as a word ("Winnipeg (CMA)"
// → "Winnipeg CMA") so the benchmark is never confused with the city.
export const proseName = (name) => String(name ?? '')
  .replace(/\s*\((CMA|CA)\)$/, ' $1')
  .replace(/\s*\([A-Z]{1,4}\)$/, '');

// Join ["a", "b", "c"] → "a, b and c".
const joinAnd = (arr) => arr.length <= 1 ? arr.join('')
  : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

// ---- stats -----------------------------------------------------------------
// Everything the sentences and the table need, computed once per region.
export function regionStats(region, { years, period }) {
  const t = region?.trends || {};
  const d = region?.demo?.[period] || null;
  const popYears = years.filter(y => pos(t[y]?.population) != null);
  const lastY = popYears[popYears.length - 1] ?? null;
  const prevY = popYears[popYears.length - 2] ?? null;
  const firstY = popYears[0] ?? null;
  const pop = (y) => (y ? pos(t[y].population) : null);
  const chg = (a, b) => (a && b && a !== b) ? (pop(b) - pop(a)) / pop(a) * 100 : null;

  // Dwelling mix from the latest census at or before the selected period that
  // carries type counts, so the stock paragraph matches the period's demographics.
  const typeY = [...years].reverse().find(y => Number(y) <= Number(period) &&
    Object.keys(TYPE_LABELS).some(k => num(t[y]?.[k]) != null)) ?? null;
  let types = null;
  if (typeY) {
    const total = Object.keys(TYPE_LABELS).reduce((s, k) => s + (num(t[typeY][k]) || 0), 0);
    if (total > 0) {
      const shares = Object.keys(TYPE_LABELS).map(k => ({ key: k, share: (num(t[typeY][k]) || 0) / total * 100 }))
        .sort((a, b) => b.share - a.share);
      types = { year: typeY, shares, aptShare: APT_KEYS.reduce((s, k) => s + (num(t[typeY][k]) || 0), 0) / total * 100 };
    }
  }

  const share = (k, denom) => {
    const n = num(d?.[k]), dn = pos(d?.[denom]);
    return (n != null && dn) ? n / dn * 100 : null;
  };
  const periodTotal = pos(d?.period_total);
  const post2000 = periodTotal ? BUILT_POST_2000.reduce((s, k) => s + (num(d[k]) || 0), 0) / periodTotal * 100 : null;

  return {
    name: proseName(region?.name),
    pop: pop(lastY), popYear: lastY,
    chg5: chg(prevY, lastY), chg5From: prevY,
    chg15: chg(firstY, lastY), chg15From: firstY,
    hhIncome: num(d?.median_hh_income),
    dwellingVal: num(d?.median_dwelling_val),
    rent: num(d?.median_rent),
    ownerShare: share('owner', 'tenure_total'),
    pre1961: share('built_1960', 'period_total'),
    post2000,
    types,
  };
}

// ---- sentences ---------------------------------------------------------------
// `benchmarks` = [{ stats, label }] in the order they should be mentioned
// (province first by convention: "below the provincial figure and well under
// Winnipeg's").
function compareClause(value, benchmarks, key) {
  const parts = [];
  for (const b of benchmarks) {
    const bv = b.stats[key];
    if (value == null || bv == null || bv <= 0) continue;
    parts.push(`${ratioPhrase(value / bv)} ${b.label} (${fUsd(bv)})`);
  }
  return joinAnd(parts);
}

function growthPara(s, benchmarks) {
  if (s.chg5 == null) {
    return s.pop != null
      ? `${s.name} had a population of ${fInt(s.pop)} at the ${s.popYear} Census; earlier census counts are not published for this area, so a growth trend cannot be read.`
      : null;
  }
  let text = `${s.name} had a population of ${fInt(s.pop)} at the ${s.popYear} Census, ` +
    `a change of ${fPct1s(s.chg5)} from ${s.chg5From}`;
  if (s.chg15 != null && s.chg15From !== s.chg5From) text += ` and ${fPct1s(s.chg15)} since ${s.chg15From}`;
  text += `. On this basis the community is ${growthWord(s.chg5)}`;
  // A growing subject is paced against each benchmark; a stable/contracting
  // one is contrasted with it ("while the province grew +5.0%") since "more
  // slowly than" makes no sense for a shrinking area.
  const growing = s.chg5 >= 1;
  const rel = benchmarks.map(b => {
    const bc = b.stats.chg5;
    if (bc == null) return null;
    if (!growing) return `${b.label.replace(/'s$/, '')} ${bc >= 1 ? 'grew' : bc <= -1 ? 'contracted' : 'was stable at'} ${fPct1s(bc)}`;
    const diff = s.chg5 - bc;
    const how = diff > RELATIVE_BAND ? 'faster than' : diff < -RELATIVE_BAND ? 'more slowly than' : 'at a similar pace to';
    return `${how} ${b.label} (${fPct1s(bc)})`;
  }).filter(Boolean);
  if (rel.length) text += growing ? `, ${joinAnd(rel)} over the same period` : `, while ${joinAnd(rel)} over the same period`;
  return text + '.';
}

function incomePara(s, benchmarks, period) {
  if (s.hhIncome == null) return null;
  let text = `Median household income was ${fUsd(s.hhIncome)} in ${incomeYear(period)}`;
  const cmp = compareClause(s.hhIncome, benchmarks, 'hhIncome');
  if (cmp) text += `, ${cmp}`;
  return text + '.';
}

function valuePara(s, benchmarks, period) {
  if (s.dwellingVal == null) return null;
  let text = `The median value of owner-occupied dwellings was ${fUsd(s.dwellingVal)} at the ${period} Census`;
  const cmp = compareClause(s.dwellingVal, benchmarks, 'dwellingVal');
  if (cmp) text += `, ${cmp}`;
  text += '.';
  if (s.rent != null) {
    let r = ` Median monthly rent was ${fUsd(s.rent)}`;
    const rc = compareClause(s.rent, benchmarks, 'rent');
    if (rc) r += `, ${rc}`;
    text += r + '.';
  }
  return text;
}

function stockPara(s) {
  const parts = [];
  if (s.types) {
    const top = s.types.shares[0];
    const lead = top.share >= 60 ? 'predominantly' : top.share >= 40 ? 'mainly' : 'mixed, led by';
    let t = `The housing stock is ${lead} ${TYPE_LABELS[top.key]} (${fPct0(top.share)} of occupied dwellings in ${s.types.year})`;
    if (top.key !== 'apt_lt5' && top.key !== 'apt_ge5' && s.types.aptShare >= 5)
      t += `, with apartments and duplex units making up ${fPct0(s.types.aptShare)}`;
    parts.push(t + '.');
  }
  if (s.post2000 != null || s.pre1961 != null) {
    const bits = [];
    if (s.post2000 != null) bits.push(`about ${fPct0(s.post2000)} of dwellings were built after 2000`);
    if (s.pre1961 != null) bits.push(`${fPct0(s.pre1961)} before 1961`);
    const era = s.post2000 >= 40 ? 'a comparatively new stock' : s.pre1961 >= 35 ? 'an older stock' : 'a stock of mixed age';
    parts.push(`The area has ${era}: ${bits.join(' and ')}.`);
  }
  if (s.ownerShare != null) parts.push(`Owner-occupancy stands at ${fPct0(s.ownerShare)}.`);
  return parts.length ? parts.join(' ') : null;
}

// ---- public API ----------------------------------------------------------------
// subject/benchmarks are census_profile regions; `years` the censusYears array;
// `period` the selected demographics census. Returns { blocks, table }.
export function buildCensusNarrative({ subject, benchmarks = [], years, period }) {
  const s = regionStats(subject, { years, period });
  const bm = benchmarks.filter(Boolean).map(r => {
    const stats = regionStats(r, { years, period });
    // "Manitoba" reads as "the provincial figure"; everything else by name + possessive.
    const label = r.level === 'PR' ? 'the provincial figure' : `${stats.name}'s`;
    return { stats, label, name: stats.name };
  });

  const blocks = [
    { type: 'title', text: `${s.name} — community profile` },
    { type: 'meta',  text: `Statistics Canada Census of Population; demographics ${period} Census` +
        (bm.length ? ` · benchmarks: ${bm.map(b => b.name).join(', ')}` : '') },
  ];
  const push = (heading, text) => { if (text) blocks.push({ type: 'heading', text: heading }, { type: 'para', text }); };
  push('Population and growth', growthPara(s, bm));
  push('Income', incomePara(s, bm, period));
  push('Dwelling values', valuePara(s, bm, period));
  push('Housing stock', stockPara(s));

  // Enrichment stubs — the judgement layer the tool deliberately leaves to the
  // appraiser (see the plan's tiered-layers principle).
  blocks.push({ type: 'heading', text: 'Appraiser notes (to complete)' });
  for (const stub of [
    'Economic base and major employers: [agriculture / manufacturing / tourism / services — name the principal employers]',
    'Services and amenities: [full-service / limited-service — grocery, K–12 schools, medical, municipal office]',
    'Access and roadways: [provincial highways serving the community; distance and direction to Winnipeg]',
  ]) blocks.push({ type: 'bullet', text: stub });

  // Supporting figures — the table the prose interprets.
  const cols = [s, ...bm.map(b => b.stats)];
  const row = (label, f) => ({ area: label, values: cols.map(c => f(c)) });
  const pct1 = (v) => v == null ? '**' : fPct1s(v);
  const pct0 = (v) => v == null ? '**' : fPct0(v);
  const table = {
    title: `Supporting figures — ${cols.map(c => c.name).join(' vs ')}`,
    columns: cols.map(c => c.name),
    rows: [
      row(`Population (${s.popYear || 'latest'})`, c => fInt(c.pop)),
      row('Change, latest inter-census period', c => pct1(c.chg5)),
      row('Change since earliest census shown', c => pct1(c.chg15)),
      row(`Median household income (${incomeYear(period)})`, c => fUsd(c.hhIncome)),
      row(`Median dwelling value (${period})`, c => fUsd(c.dwellingVal)),
      row(`Median monthly rent (${period})`, c => fUsd(c.rent)),
      row('Owner-occupied share', c => pct0(c.ownerShare)),
      row('Single-detached share of dwellings', c => pct0(c.types?.shares.find(x => x.key === 'single_detached')?.share)),
      row('Dwellings built after 2000', c => pct0(c.post2000)),
    ],
  };
  return { blocks, table, stats: s };
}
