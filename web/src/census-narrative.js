/*
 * Census narrative — turns a census_profile.json region (plus benchmark
 * regions) into a short, general appraisal-report "community profile": where
 * the community is and how it is trending, its housing and incomes relative to
 * the benchmarks, and its economy and access. Pure functions, no DOM — census.js
 * renders the blocks on screen and hands the same blocks to the Word export.
 *
 * Deliberately GENERAL (Jason, 2026-10-31): the prose characterises, the tables
 * beneath carry the numbers. No population counts (his reports always include
 * population tables), no exact percentages or dollar figures, distances rounded
 * to 5 km. Every sentence degrades gracefully — a missing value drops the
 * clause rather than printing "**" into prose.
 *
 * The bands below are the whole "voice" of the tool; keep them in these tables
 * rather than inline so the wording stays repeatable across reports.
 */

import { miss, fInt, fUsd } from './format.js';
import { servicesPara } from './service-tier.js';

// Subject ÷ benchmark ratio → phrase. Ordered high → low; first match wins.
// Wide bands on purpose: the prose should say "below", not split hairs.
export const RATIO_LADDER = [
  { min: 1.15, phrase: 'well above' },
  { min: 1.05, phrase: 'above' },
  { min: 0.95, phrase: 'broadly in line with' },
  { min: 0.85, phrase: 'below' },
  { min: -Infinity, phrase: 'well below' },
];

// Long-run population change as an ANNUAL rate (% per year, so a 5-year and a
// 15-year span read on the same scale) → trajectory phrase.
export const GROWTH_CLASSES = [
  { min: 2,         phrase: 'grown strongly' },
  { min: 0.9,       phrase: 'grown steadily' },
  { min: 0.4,       phrase: 'grown modestly' },
  { min: -0.4,      phrase: 'remained essentially stable' },
  { min: -Infinity, phrase: 'declined' },
];
// Subject minus benchmark annual rate (percentage points) → faster / in line / slower.
export const RELATIVE_BAND = 0.5;

// Location quotient = subject share ÷ provincial share. A sector is named as a
// standout when it is both concentrated (LQ ≥ LQ_MIN) and material (share ≥
// LQ_SHARE_MIN %), so a 1%-of-labour-force sector never headlines.
export const LQ_MIN = 1.5;
export const LQ_SHARE_MIN = 4;

// Structural-type keys (trend counts) used for the dwelling mix.
const TYPE_KEYS = ['single_detached', 'apt_lt5', 'apt_ge5', 'semi_detached', 'row_house',
                   'apt_duplex', 'movable', 'other_attached'];
const APT_KEYS = ['apt_lt5', 'apt_ge5', 'apt_duplex'];
const BUILT_POST_2000 = ['built_2001_2005', 'built_2006_2010', 'built_2011_2015', 'built_2016_2021'];

// Short sector names for prose, by NAICS code.
const SECTOR_SHORT = {
  '11': 'agriculture', '21': 'mining and oil and gas', '22': 'utilities', '23': 'construction',
  '31-33': 'manufacturing', '41': 'wholesale trade', '44-45': 'retail', '48-49': 'transportation',
  '51': 'information and culture', '52': 'finance and insurance', '53': 'real estate',
  '54': 'professional services', '55': 'management of companies', '56': 'administrative services',
  '61': 'education', '62': 'health care', '71': 'arts and recreation', '72': 'accommodation and food services',
  '81': 'other services', '91': 'public administration',
};

const num = (v) => (miss(v) ? null : Number(v));
// Census zeros for population/households mean "not published" (e.g. Steinbach
// CA 2011), never a real empty area — treat them as missing too.
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };

export const ratioPhrase  = (ratio) => RATIO_LADDER.find(l => ratio >= l.min).phrase;
export const growthPhrase = (rate)  => GROWTH_CLASSES.find(g => rate >= g.min).phrase;

// Compound annual rate (% per year) between two counts `years` apart.
const annual = (from, to, years) =>
  (from > 0 && to > 0 && years > 0) ? (Math.pow(to / from, 1 / years) - 1) * 100 : null;
const spanWords = (n) => ({ 5: 'five', 10: 'ten', 15: 'fifteen', 20: 'twenty' }[n] || String(n));

const fPct1s = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;   // signed, typographic minus
const fPct0  = (v) => `${Math.round(v)}%`;
const fPct1  = (v) => `${v.toFixed(1)}%`;

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
const capitalise = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// ---- stats -----------------------------------------------------------------
// Everything the sentences and the tables need, computed once per region.
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
  // carries type counts, so the housing sentence matches the period's demographics.
  const typeY = [...years].reverse().find(y => Number(y) <= Number(period) &&
    TYPE_KEYS.some(k => num(t[y]?.[k]) != null)) ?? null;
  let types = null;
  if (typeY) {
    const total = TYPE_KEYS.reduce((s, k) => s + (num(t[typeY][k]) || 0), 0);
    if (total > 0) {
      const shares = TYPE_KEYS.map(k => ({ key: k, share: (num(t[typeY][k]) || 0) / total * 100 }))
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
    // Annualised rates for the prose: long run (earliest → latest census) and
    // the latest inter-census period.
    rateLong: (firstY && lastY && firstY !== lastY) ? annual(pop(firstY), pop(lastY), lastY - firstY) : null,
    rateLongYears: (firstY && lastY) ? lastY - firstY : null,
    rateLatest: (prevY && lastY) ? annual(pop(prevY), pop(lastY), lastY - prevY) : null,
    hhIncome: num(d?.median_hh_income),
    dwellingVal: num(d?.median_dwelling_val),
    rent: num(d?.median_rent),
    ownerShare: share('owner', 'tenure_total'),
    pre1961: share('built_1960', 'period_total'),
    post2000,
    types,
  };
}

// Labour-force shares by sector for one region at the selected census, or
// null when the file lacks that region/year (the sentence is then omitted —
// no substituting 2021 for a 2016 read).
export function industryStats(industry, uid, period) {
  const r = industry?.regions?.find(x => x.uid === uid);
  const d = r?.data?.[period];
  const lf = pos(d?.labourForce);
  if (!d || !lf || !Array.isArray(d.counts)) return null;
  const shares = industry.sectors.map((sec, i) => ({
    code: sec.code, label: sec.label, count: num(d.counts[i]) ?? 0,
    share: (num(d.counts[i]) ?? 0) / lf * 100,
  }));
  return { year: period, labourForce: lf, shares, byCode: new Map(shares.map(x => [x.code, x])),
           commute: d.commute ?? null };
}

// ---- sentences ---------------------------------------------------------------
// Benchmarks are named generally: the province is "the province" /
// "provincial"; anything else by its prose name ("the Winnipeg CMA").
const isMetro = (name) => / (CMA|CA)$/.test(name);
const bmNoun = (b) => b.level === 'PR' ? 'the province' : (isMetro(b.name) ? `the ${b.name}` : b.name);
const bmAdj  = (b) => b.level === 'PR' ? 'provincial' : b.name;
// "the provincial and Winnipeg CMA levels" / "the provincial level"
const levelsOf = (bs) => `the ${joinAnd(bs.map(bmAdj))} level${bs.length > 1 ? 's' : ''}`;

// One comparison clause for a metric across all benchmarks: a single phrase
// when every benchmark reads the same ("below the provincial and Winnipeg CMA
// levels"), otherwise one phrase per benchmark.
function compareAll(value, benchmarks, key) {
  if (value == null) return null;
  const parts = benchmarks.filter(b => b.stats[key] > 0)
    .map(b => ({ b, phrase: ratioPhrase(value / b.stats[key]) }));
  if (!parts.length) return null;
  if (parts.every(p => p.phrase === parts[0].phrase)) return `${parts[0].phrase} ${levelsOf(parts.map(p => p.b))}`;
  const each = parts.map(p => `${p.phrase} ${levelsOf([p.b])}`);
  return each.length === 2 ? `${each[0]} but ${each[1]}` : joinAnd(each);
}

// Where the community sits and how its population has trended — no counts.
function locationGrowthPara(s, benchmarks, hw) {
  const parts = [];
  if (hw?.wpgKm != null) {
    // "… is located roughly 75 km northeast of Winnipeg and is served by PTH 11."
    const where = hw.wpgKm === 0
      ? `${s.name} adjoins the City of Winnipeg to the ${hw.wpgDir}`
      : `${s.name} is located roughly ${Math.max(5, Math.round(hw.wpgKm / 5) * 5)} km ${hw.wpgDir} of Winnipeg`;
    const roads = accessClause(hw);
    parts.push(roads?.startsWith('is ') ? `${where} and ${roads}.` : `${where}.${roads ? ` ${roads}` : ''}`);
  }
  if (s.rateLong != null) {
    const span = s.rateLongYears === 5 ? 'Between the last two censuses' : `Over the past ${spanWords(s.rateLongYears)} years`;
    let t = `${span}, the population has ${growthPhrase(s.rateLong)}`;
    // Flag a latest census that runs against the long-run trend.
    if (s.rateLongYears > 5 && s.rateLatest != null) {
      if (s.rateLong >= -0.4 && s.rateLatest <= -0.4) t += ', with a slight decline in the most recent census period';
      else if (s.rateLong < 0.4 && s.rateLatest >= 0.9) t += ', with renewed growth in the most recent census period';
    }
    const rel = benchmarks.map(b => {
      // Like with like: the benchmark's rate over the subject's span.
      const br = b.stats.rateLongYears === s.rateLongYears ? b.stats.rateLong
        : (s.rateLongYears === 5 ? b.stats.rateLatest : null);
      if (br == null) return null;
      const diff = s.rateLong - br;
      return { b, br, how: diff > RELATIVE_BAND ? 'faster than' : diff < -RELATIVE_BAND ? 'more slowly than' : 'in line with' };
    }).filter(Boolean);
    if (rel.length) {
      if (s.rateLong < 0.4) {
        // Stable / declining subject: contrast rather than pace it.
        const growers = rel.filter(r => r.br >= 0.4).map(r => bmNoun(r.b));
        if (growers.length) t += `, while ${joinAnd(growers)} continued to grow`;
      } else if (rel.every(r => r.how === rel[0].how)) {
        t += `, ${rel[0].how} ${joinAnd(rel.map(r => bmNoun(r.b)))}`;
      } else {
        t += `, ${joinAnd(rel.map(r => `${r.how} ${bmNoun(r.b)}`))}`;
      }
    }
    parts.push(t + '.');
  }
  return parts.length ? parts.join(' ') : null;
}

// Incomes, home values and rents vs the benchmarks, then the housing mix.
function housingIncomePara(s, benchmarks) {
  const parts = [];
  const metrics = [
    { key: 'hhIncome',    noun: 'household incomes', v: s.hhIncome },
    { key: 'dwellingVal', noun: 'home values',       v: s.dwellingVal },
    { key: 'rent',        noun: 'rents',             v: s.rent },
  ].map(m => ({ ...m, clause: compareAll(m.v, benchmarks, m.key) })).filter(m => m.clause);
  if (metrics.length) {
    // Group metrics that read the same: "Household incomes and home values are
    // below …, while rents are broadly in line with …".
    const groups = [];
    for (const m of metrics) {
      const g = groups.find(x => x.clause === m.clause);
      if (g) g.nouns.push(m.noun); else groups.push({ clause: m.clause, nouns: [m.noun] });
    }
    const clauses = groups.map(g => `${joinAnd(g.nouns)} are ${g.clause}`);
    const sentence = clauses.length === 1 ? clauses[0]
      : clauses.length === 2 ? `${clauses[0]}, while ${clauses[1]}`
      : `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
    parts.push(capitalise(sentence) + '.');
  }

  // "Housing is mostly owner-occupied and consists mainly of single-family
  // homes, with a modest apartment component."
  const tenure = s.ownerShare == null ? null
    : s.ownerShare >= 65 ? 'mostly owner-occupied' : s.ownerShare >= 50 ? 'largely owner-occupied'
    : 'split between owners and renters';
  let mix = null;
  if (s.types) {
    const sd = s.types.shares.find(x => x.key === 'single_detached')?.share ?? 0;
    mix = sd >= 60 ? 'mainly of single-family homes'
      : sd >= 40 ? 'of a mix of single-family homes and multi-unit dwellings'
      : 'mainly of multi-unit dwellings';
    if (sd >= 60 && s.types.aptShare >= 25) mix += ', with a significant apartment component';
    else if (sd >= 60 && s.types.aptShare >= 10) mix += ', with a modest apartment component';
  }
  if (tenure && mix) parts.push(`Housing is ${tenure} and consists ${mix}.`);
  else if (tenure) parts.push(`Housing is ${tenure}.`);
  else if (mix) parts.push(`Housing consists ${mix}.`);

  if (s.post2000 != null && s.post2000 >= 40) parts.push('Much of the stock has been built since 2000.');
  else if (s.pre1961 != null && s.pre1961 >= 35) parts.push('Much of the stock predates 1961.');
  else if (s.post2000 != null && s.post2000 < 15) parts.push('There has been relatively little recent construction.');
  else if (s.post2000 != null || s.pre1961 != null) parts.push('The stock is a mix of older and newer construction.');
  return parts.length ? parts.join(' ') : null;
}

const sectorName = (x) => SECTOR_SHORT[x.code] || x.label.toLowerCase();

// How a standout sector reads as a local economic driver.
const SECTOR_DRIVER = {
  '11': 'agriculture', '21': 'mining and resource extraction',
  '22': 'hydro-electric and other utility operations', '23': 'construction',
  '31-33': 'manufacturing', '41': 'wholesale distribution', '48-49': 'transportation and trucking',
  '61': 'education', '62': 'health care', '91': 'government and public administration',
  tourism: 'tourism and recreation',
};
// Community-serving sectors: a concentration here, with most residents working
// locally, reads as a service-centre role for the surrounding area.
const SERVICE_CODES = ['44-45', '61', '62', '91'];
export const SERVICE_EXCESS = 5;        // percentage points above the province

// Commuting bands (share of employed residents with a usual place of work who
// work within their own municipality).
export const COMMUTE_LOCAL = 60;
export const COMMUTE_SPLIT = 40;
export const WPG_COMMUTE_KM = 60;       // "largely toward Winnipeg" only within this distance

// The local economy, in words: leading sectors, the standout drivers vs the
// province, a service-centre read, where residents work, and named employers
// when the appraiser has supplied them.
function economyPara(s, ind, benchmarks, { hw = null, employers = [] } = {}) {
  const parts = [];
  if (ind) {
    const top = ind.shares.slice().sort((a, b) => b.share - a.share).slice(0, 3);
    parts.push(`Employment is led by ${joinAnd(top.map(sectorName))}.`);

    const prov = benchmarks.find(b => b.level === 'PR' && b.industry);
    if (prov) {
      const pshare = (code) => prov.industry.byCode.get(code)?.share ?? 0;
      const over = ind.shares
        .map(x => ({ ...x, lq: pshare(x.code) > 0 ? x.share / pshare(x.code) : 0 }))
        .filter(x => x.lq >= LQ_MIN && x.share >= LQ_SHARE_MIN)
        .sort((a, b) => b.lq - a.lq);
      // Accommodation/food and arts/recreation read together as tourism.
      const drivers = [];
      for (const x of over) {
        const key = (x.code === '71' || x.code === '72') ? 'tourism' : x.code;
        const phrase = SECTOR_DRIVER[key] || sectorName(x);
        if (!drivers.includes(phrase)) drivers.push(phrase);
      }
      if (drivers.length) {
        parts.push(`The local economy leans on ${joinAnd(drivers.slice(0, 2))}, ` +
          `${drivers.length > 1 ? 'both' : 'which is'} notably more prominent than across the province.`);
      } else {
        parts.push('No single sector stands out relative to the province; the employment base is broadly diversified.');
      }
      const svc = (byCode) => SERVICE_CODES.reduce((sum, c) => sum + (byCode.get(c)?.share ?? 0), 0);
      const c = ind.commute;
      const local = c?.total > 0 ? c.withinCsd / c.total * 100 : null;
      if (svc(ind.byCode) - svc(prov.industry.byCode) >= SERVICE_EXCESS && local != null && local >= COMMUTE_SPLIT) {
        parts.push('Its concentration in health care, retail, education and public administration is consistent with a role as a service centre for the surrounding area.');
      }
    }

    // Where employed residents work.
    const c = ind.commute;
    if (c?.total > 0) {
      const local = c.withinCsd / c.total * 100;
      const outRegion = (c.otherCd + c.otherProv) / c.total * 100;
      const sameRegion = c.otherCsdSameCd / c.total * 100;
      const towardWpg = hw?.wpgKm != null && hw.wpgKm <= WPG_COMMUTE_KM ? ', largely toward Winnipeg' : '';
      if (local >= COMMUTE_LOCAL) {
        parts.push('Most employed residents work within the community, so it functions as a local employment centre rather than a commuter community.');
      } else if (local >= COMMUTE_SPLIT) {
        parts.push(outRegion >= sameRegion
          ? `About half of employed residents work locally, and much of the rest commute out of the region${towardWpg}.`
          : 'About half of employed residents work locally, and much of the rest work in neighbouring communities.');
      } else if (outRegion >= sameRegion) {
        parts.push(`Most employed residents commute out of the region for work${towardWpg}, so the community functions partly as a bedroom community.`);
      } else {
        parts.push('Most employed residents work in neighbouring communities within the region rather than locally.');
      }
    }
  }
  if (employers.length) parts.push(`Major local employers include ${joinAnd(employers)}.`);
  return parts.length ? parts.join(' ') : null;
}

// Main highways only — PTHs through the municipality, else what passes nearby.
// Returns a predicate ("is served by …") to join onto the location sentence, or
// a standalone sentence when nothing passes through.
function accessClause(hw) {
  if (!hw) return null;
  const through = hw.through || [], nearby = hw.nearby || [];
  const pth = through.filter(r => r.startsWith('PTH'));
  if (pth.length) return `is served by ${joinAnd(pth.slice(0, 4))}${pth.length > 4 ? ', among other provincial highways' : ''}`;
  if (through.length) return `is served by ${joinAnd(through.slice(0, 2))}`;
  const near = nearby.find(n => n.route.startsWith('PTH')) || nearby[0];
  if (near) return `${near.route} passes nearby.`;
  return 'There is no all-weather provincial road access; the community is reached by air, water or winter road.';
}

// ---- public API ----------------------------------------------------------------
// subject/benchmarks are census_profile regions; `years` the censusYears array;
// `period` the selected demographics census; `industry` / `highways` the
// (optional) parsed census_industry.json / mb_csd_highways.json; `services`
// the appraiser's local inputs ({ checked, nearest, employers }).
// Returns { blocks, table, industryTable, stats }.
export function buildCensusNarrative({ subject, benchmarks = [], years, period, industry = null, highways = null, services = null }) {
  const s = regionStats(subject, { years, period });
  const sInd = industryStats(industry, subject?.uid, period);
  const sHw = subject?.level === 'CSD' ? (highways?.csd?.[subject.uid] ?? null) : null;
  // `benchmarks` arrive in the user's Area 2/3 order, which both the prose and
  // the tables keep.
  const bm = benchmarks.filter(Boolean).map(r => {
    const stats = regionStats(r, { years, period });
    return { stats, name: stats.name, level: r.level, industry: industryStats(industry, r.uid, period) };
  });

  const blocks = [
    { type: 'title', text: `${s.name} — community profile` },
    { type: 'meta',  text: `Statistics Canada Census of Population; demographics ${period} Census` +
        (bm.length ? ` · benchmarks: ${bm.map(b => b.name).join(', ')}` : '') },
  ];
  const push = (heading, text) => { if (text) blocks.push({ type: 'heading', text: heading }, { type: 'para', text }); };
  push('Location and growth', locationGrowthPara(s, bm, sHw));
  push('Housing and income', housingIncomePara(s, bm));
  // Named employers are local knowledge the appraiser types in (Local inputs).
  const employers = (services?.employers || []).map(e => String(e).trim()).filter(Boolean);
  push('Local economy', economyPara(s, sInd, bm, { hw: sHw, employers }));
  // Services come from the appraiser's checklist (service-tier.js rubric), not data.
  const svcText = services?.checked?.length ? servicesPara(s.name, services.checked, services.nearest) : null;
  push('Services and amenities', svcText);

  // Enrichment stubs — the judgement layer the tool deliberately leaves to the
  // appraiser (see the plan's tiered-layers principle). A stub drops out once
  // data covers it.
  blocks.push({ type: 'heading', text: 'Appraiser notes (to complete)' });
  for (const stub of [
    employers.length ? null
      : sInd ? 'Major employers: [name the principal local employers — enter them under Local inputs below]'
      : 'Economic base and major employers: [agriculture / manufacturing / tourism / services — name the principal employers]',
    svcText ? null : 'Services and amenities: [full-service / limited-service — tick the services checklist below to fill this in]',
    sHw ? null : 'Location and access: [where the community sits relative to Winnipeg; highways serving it]',
  ].filter(Boolean)) blocks.push({ type: 'bullet', text: stub });

  // Supporting figures — the numbers behind the prose. No population count:
  // Jason's reports carry their own population tables.
  const cols = [s, ...bm.map(b => b.stats)];
  const row = (label, f) => ({ area: label, values: cols.map(c => f(c)) });
  const pct1 = (v) => v == null ? '**' : fPct1s(v);
  const pct0 = (v) => v == null ? '**' : fPct0(v);
  const table = {
    title: `Supporting figures — ${cols.map(c => c.name).join(' vs ')}`,
    columns: cols.map(c => c.name),
    rows: [
      row(`Population change, ${s.chg5From || 'prior'}–${s.popYear || 'latest'}`, c => pct1(c.chg5)),
      row(`Population change, ${s.chg15From || 'earliest'}–${s.popYear || 'latest'}`, c => pct1(c.chg15)),
      row(`Median household income (${incomeYear(period)})`, c => fUsd(c.hhIncome)),
      row(`Median dwelling value (${period})`, c => fUsd(c.dwellingVal)),
      row(`Median monthly rent (${period})`, c => fUsd(c.rent)),
      row('Owner-occupied share', c => pct0(c.ownerShare)),
      row('Single-detached share of dwellings', c => pct0(c.types?.shares.find(x => x.key === 'single_detached')?.share)),
      row('Dwellings built after 2000', c => pct0(c.post2000)),
    ],
  };

  // Labour force by sector, subject vs benchmarks, sorted by the subject's
  // share — only when the subject has industry data for this period.
  let industryTable = null;
  if (sInd) {
    const icols = [{ name: s.name, ind: sInd }, ...bm.map(b => ({ name: b.name, ind: b.industry }))];
    const order = sInd.shares.slice().sort((a, b) => b.share - a.share).map(x => x.code);
    industryTable = {
      title: `Labour force by industry (${period}) — ${icols.map(c => c.name).join(' vs ')}`,
      columns: icols.map(c => c.name),
      rows: [
        { area: 'Labour force aged 15+', values: icols.map(c => fInt(c.ind?.labourForce)) },
        ...order.map(code => ({
          area: `${code} ${sInd.byCode.get(code).label}`,
          values: icols.map(c => { const x = c.ind?.byCode.get(code); return x ? fPct1(x.share) : '**'; }),
        })),
      ],
    };
  }
  return { blocks, table, industryTable, stats: s };
}
