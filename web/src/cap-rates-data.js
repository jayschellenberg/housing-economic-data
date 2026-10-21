/*
 * Cap Rates — data model (pure functions, no DOM).
 *
 * Input is cap_rates.json from Cap-Rates/ingest/parse_cap_rates.py: one row
 * per (quarter, firm, property type, class) with the published Low / High
 * range and its mid-point, as fractions (0.0625). Everything here works in
 * PERCENT (6.25) because that is how the site's other percent series are
 * stored and formatted.
 *
 * The tab shows, per property type:
 *   - average cap rate by class (mean of the firms' mid-points),
 *   - one class by firm (each firm's mid-point + the average),
 *   - that class's range (lowest Low to highest High across firms, with the
 *     average mid-point),
 *   - the selected quarter's table, in the workbook's own layout.
 */

// Office is shown as two types on the Cap Rates tab (splitOfficeByLocation);
// a plain "Office" row (no Downtown / Suburban in its class) still sorts here.
// Section order on the Cap Rates tab (Jason, 2026-10-21): Multi-Family first; the
// overall Office section is drawn just before Downtown Office.
export const TYPE_ORDER = ['Multi-Family', 'Industrial', 'Retail', 'Downtown Office', 'Suburban Office', 'Office', 'Hotel', 'Self Storage'];

// Display order of classes within a type; anything unlisted follows, alphabetical.
export const SUBTYPE_ORDER = {
  Industrial: ['Class A', 'Class B'],
  // The workbook's Summary sheet (the 2010–2020 backfill) groups retail and
  // multi-family differently from the quarterly sheets; those older class
  // names follow the current ones.
  Retail: ['Regional Mall', 'Power Centre', 'Community Centre', 'Strip (Anchored)', 'Strip (Non-Anchored)',
           'Regional/Power Centre', 'Grocery/Community Centre', 'Neighbourhood Strip'],
  Office: ['Downtown Class A', 'Downtown Class B', 'Suburban Class A', 'Suburban Class B'],
  'Downtown Office': ['Class A', 'Class B'],
  'Suburban Office': ['Class A', 'Class B'],
  'Multi-Family': ['High Rise', 'Low Rise (A)', 'Low Rise (B)', 'Low Rise'],
  Hotel: ['Downtown Full Service', 'Focused Service', 'Suburban Limited Service'],
  'Self Storage': ['All'],
};

export const FIRM_ORDER = ['Colliers', 'CBRE', 'Cushman & Wakefield'];

/**
 * The Cap Rates tab's view of the rows: Office becomes two property types,
 * "Downtown Office" and "Suburban Office", each with Class A / Class B —
 * so each gets its own chart and quarter table (Jason, 2026-09-30). The
 * brokerages publish the two markets separately; averaging them into one
 * "Office" figure mixed two different markets. Other types pass through.
 * Cap vs Interest reads the stored rows itself and keeps its single Office
 * overlay.
 */
export function splitOfficeByLocation(rows) {
  return rows.map(r => {
    if (r.type !== 'Office') return r;
    const m = /^(Downtown|Suburban)\s+(.+)$/.exec(String(r.subtype || ''));
    return m ? { ...r, type: `${m[1]} Office`, subtype: m[2] } : r;
  });
}
export const AVERAGE = 'Average';

const pct = (v) => (v == null ? null : Math.round(v * 10000) / 100);

export function orderBy(list, order) {
  const idx = new Map((order || []).map((x, i) => [x, i]));
  return [...list].sort((a, b) => {
    const ia = idx.has(a) ? idx.get(a) : 1e9;
    const ib = idx.has(b) ? idx.get(b) : 1e9;
    return ia - ib || a.localeCompare(b);
  });
}

export function quarterKey(q) {
  const m = /^(\d{4})\s*Q([1-4])$/.exec(String(q || '').trim());
  return m ? Number(m[1]) * 10 + Number(m[2]) : 0;
}

/** Quarters present in the data, oldest first, as "2026 Q2" strings. */
export function quarterList(data) {
  const set = new Set((data?.rows || []).map(r => r.quarter));
  return [...set].sort((a, b) => quarterKey(a) - quarterKey(b));
}

export function typesPresent(rows) {
  return orderBy([...new Set(rows.map(r => r.type))], TYPE_ORDER);
}

export function subtypesFor(rows, type) {
  return orderBy([...new Set(rows.filter(r => r.type === type).map(r => r.subtype))], SUBTYPE_ORDER[type]);
}

export function firmsFor(rows) {
  return orderBy([...new Set(rows.map(r => r.firm))], FIRM_ORDER);
}

/** Rows up to and including a quarter (all rows when quarter is null). */
export function rowsUpTo(rows, quarter) {
  if (!quarter) return rows;
  const k = quarterKey(quarter);
  return rows.filter(r => quarterKey(r.quarter) <= k);
}

function mean(xs) {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** { line: subtype, date, value } — mean of firm mid-points, in percent. */
export function averageByClass(rows, type) {
  const groups = new Map();
  for (const r of rows) {
    if (r.type !== type || r.mid == null) continue;
    const key = `${r.subtype}\u0000${r.date}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(r.mid);
  }
  return [...groups.entries()].map(([key, mids]) => {
    const [line, date] = key.split('\u0000');
    return { line, date, value: pct(mean(mids)) };
  }).sort((a, b) => a.line.localeCompare(b.line) || a.date.localeCompare(b.date));
}

/**
 * Rows of several types relabelled as one ("Downtown Office" + "Suburban
 * Office" → "Office"), for an all-office series. Other rows are dropped.
 */
export function combineTypes(rows, types, as) {
  const set = new Set(types);
  return rows.filter(r => set.has(r.type)).map(r => ({ ...r, type: as }));
}

/**
 * { line: firm, date, value } — each firm's overall cap rate for a property
 * type: the mean of ITS published class mid-points that quarter (Industrial
 * = Class A and B together; Office = all four classes), in percent. The
 * chart the appraiser keeps in Excel: one line per brokerage.
 */
export function averageByFirm(rows, type) {
  const groups = new Map();
  for (const r of rows) {
    if (r.type !== type || r.mid == null) continue;
    const key = `${r.firm}\u0000${r.date}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(r.mid);
  }
  return [...groups.entries()].map(([key, mids]) => {
    const [line, date] = key.split('\u0000');
    return { line, date, value: pct(mean(mids)) };
  }).sort((a, b) => a.line.localeCompare(b.line) || a.date.localeCompare(b.date));
}

/** Five years before the latest quarter's year: the default chart start (its Q1). */
export function defaultYearFrom(quarters) {
  if (!quarters?.length) return null;
  const last = quarters[quarters.length - 1];
  const y = Number(String(last).slice(0, 4));
  return Number.isFinite(y) ? y - 5 : null;
}

/** { line: firm | 'Average', date, value } for one class, in percent. */
export function byFirm(rows, type, subtype) {
  const out = [];
  const byDate = new Map();
  for (const r of rows) {
    if (r.type !== type || r.subtype !== subtype || r.mid == null) continue;
    out.push({ line: r.firm, date: r.date, value: pct(r.mid) });
    (byDate.get(r.date) || byDate.set(r.date, []).get(r.date)).push(r.mid);
  }
  for (const [date, mids] of byDate) out.push({ line: AVERAGE, date, value: pct(mean(mids)) });
  return out.sort((a, b) => a.line.localeCompare(b.line) || a.date.localeCompare(b.date));
}

/** { date, low, high, avg } per quarter for one class: lowest Low, highest High, mean mid. */
export function rangeSeries(rows, type, subtype) {
  const byDate = new Map();
  for (const r of rows) {
    if (r.type !== type || r.subtype !== subtype) continue;
    const cur = byDate.get(r.date) || { low: [], high: [], mid: [] };
    if (r.low != null) cur.low.push(r.low);
    if (r.high != null) cur.high.push(r.high);
    if (r.mid != null) cur.mid.push(r.mid);
    byDate.set(r.date, cur);
  }
  return [...byDate.entries()].map(([date, c]) => ({
    date,
    low: c.low.length ? pct(Math.min(...c.low)) : null,
    high: c.high.length ? pct(Math.max(...c.high)) : null,
    avg: pct(mean(c.mid)),
  })).sort((a, b) => a.date.localeCompare(b.date));
}

/** The quarter before "2026 Q3" ("2026 Q2"); null for an unparseable one. */
export function previousQuarter(quarter) {
  const k = quarterKey(quarter);
  if (!k) return null;
  const y = Math.floor(k / 10), q = k % 10;
  return q === 1 ? `${y - 1} Q4` : `${y} Q${q - 1}`;
}

/**
 * One quarter's table for a type, in the workbook's layout:
 *   { subtypes, firms, cells: { [firm]: { [subtype]: { low, high } } }, average: { [subtype]: { low, high } },
 *     carried: { [firm]: '2026 Q2' } }
 * Values in percent. `average` is the mean across firms of Low and of High.
 *
 * A brokerage that published this type last quarter but hasn't yet this
 * quarter (a report that's late) keeps its previous-quarter figures, listed
 * in `carried` so the table can mark them, and counted in the average (Jason,
 * 2026-10-21). Only one quarter back, so a brokerage that stopped publishing
 * a type isn't padded with stale figures; and only in the classes this
 * quarter already shows (class names changed at the 2021 Summary join).
 */
export function quarterTable(rows, type, quarter) {
  const sel = rows.filter(r => r.type === type && r.quarter === quarter);
  const subtypes = subtypesFor(sel, type);
  const cells = {};
  for (const r of sel) {
    (cells[r.firm] ||= {})[r.subtype] = { low: pct(r.low), high: pct(r.high) };
  }
  const carried = {};
  const prev = previousQuarter(quarter);
  if (sel.length && prev) {
    const shown = new Set(subtypes);
    const current = new Set(Object.keys(cells));
    for (const r of rows) {
      if (r.type !== type || r.quarter !== prev || current.has(r.firm) || !shown.has(r.subtype)) continue;
      carried[r.firm] = prev;
      (cells[r.firm] ||= {})[r.subtype] = { low: pct(r.low), high: pct(r.high) };
    }
  }
  const firms = orderBy(Object.keys(cells), FIRM_ORDER);
  const average = {};
  for (const s of subtypes) {
    const lows = firms.map(f => cells[f]?.[s]?.low).filter(v => v != null);
    const highs = firms.map(f => cells[f]?.[s]?.high).filter(v => v != null);
    average[s] = { low: lows.length ? Math.round(mean(lows) * 100) / 100 : null, high: highs.length ? Math.round(mean(highs) * 100) / 100 : null };
  }
  return { subtypes, firms, cells, average, carried };
}

/** "Cushman & Wakefield*" for a carried-forward brokerage, else the name. */
export function firmLabel(table, firm) {
  return table.carried?.[firm] ? `${firm}*` : firm;
}

/** The table's footnote for carried-forward figures, or '' when there are none. */
export function carriedNote(table, quarter) {
  const prev = [...new Set(Object.values(table.carried || {}))];
  return prev.length ? `* ${prev.join(' / ')} figure; ${quarter} not yet published.` : '';
}

export const ALL_CLASSES = 'All classes';

/**
 * Collapse a quarterTable to one column pair: each brokerage's Low and High
 * are the means of the Lows and Highs it published across the classes (only
 * those it published — Colliers has no Suburban Class A), and the Average
 * row is the mean of those brokerage figures. `classes` keeps the names
 * that went in, for the subtitle.
 */
export function collapseClasses(table, label = ALL_CLASSES) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const avg = (xs) => (xs.length ? r2(mean(xs)) : null);
  const cells = {};
  for (const f of table.firms) {
    const got = table.subtypes.map(s => table.cells[f]?.[s]).filter(Boolean);
    cells[f] = { [label]: {
      low: avg(got.map(c => c.low).filter(v => v != null)),
      high: avg(got.map(c => c.high).filter(v => v != null)),
    } };
  }
  const col = (k) => table.firms.map(f => cells[f][label][k]).filter(v => v != null);
  return {
    subtypes: [label], firms: table.firms, cells,
    average: { [label]: { low: avg(col('low')), high: avg(col('high')) } },
    classes: table.subtypes,
    carried: { ...(table.carried || {}) },
  };
}

/**
 * All office cap rates in one quarter table: a Downtown and a Suburban column
 * pair, each the brokerage's all-class range for that market (collapseClasses)
 * and the Average row across brokerages. Null when neither market has figures
 * that quarter. Reads split rows (splitOfficeByLocation).
 */
export function officeTotalsTable(rows, quarter) {
  const parts = [['Downtown', 'Downtown Office'], ['Suburban', 'Suburban Office']]
    .map(([label, type]) => [label, quarterTable(rows, type, quarter)])
    .filter(([, t]) => t.subtypes.length)
    .map(([label, t]) => collapseClasses(t, label));
  if (!parts.length) return null;
  const firms = orderBy([...new Set(parts.flatMap(p => p.firms))], FIRM_ORDER);
  const cells = {};
  for (const f of firms) cells[f] = Object.assign({}, ...parts.map(p => p.cells[f] || {}));
  return {
    subtypes: parts.flatMap(p => p.subtypes),
    firms,
    cells,
    average: Object.assign({}, ...parts.map(p => p.average)),
    carried: Object.assign({}, ...parts.map(p => p.carried || {})),
  };
}

/**
 * All office cap rates by class in one quarter table, the workbook's layout:
 * Downtown and Suburban across the top, Class A / Class B under each, Low /
 * High under those. Columns are keyed "Downtown Class A" etc.; `groups` gives
 * the top header row and `labels` the class names shown under it. Carries a
 * late brokerage forward like quarterTable. Null when neither market has
 * figures that quarter. Reads split rows (splitOfficeByLocation).
 */
export function officeByClassTable(rows, quarter) {
  const parts = [['Downtown', 'Downtown Office'], ['Suburban', 'Suburban Office']]
    .map(([label, type]) => [label, quarterTable(rows, type, quarter)])
    .filter(([, t]) => t.subtypes.length);
  if (!parts.length) return null;
  const key = (label, sub) => `${label} ${sub}`;
  const firms = orderBy([...new Set(parts.flatMap(([, t]) => t.firms))], FIRM_ORDER);
  const cells = {};
  const average = {};
  const labels = {};
  for (const [label, t] of parts) {
    for (const sub of t.subtypes) {
      const k = key(label, sub);
      labels[k] = sub;
      average[k] = t.average[sub];
      for (const f of firms) {
        if (t.cells[f]?.[sub]) (cells[f] ||= {})[k] = t.cells[f][sub];
      }
    }
  }
  return {
    subtypes: parts.flatMap(([label, t]) => t.subtypes.map(sub => key(label, sub))),
    groups: parts.map(([label, t]) => ({ label, span: t.subtypes.length })),
    labels,
    firms,
    cells,
    average,
    carried: Object.assign({}, ...parts.map(([, t]) => t.carried)),
  };
}

/** The quarter-end date that follows an ISO date. */
export function nextQuarterEnd(iso) {
  const [y, m] = String(iso).split('-').map(Number);
  const q = Math.ceil(m / 3);
  const ny = q === 4 ? y + 1 : y;
  const nq = q === 4 ? 1 : q + 1;
  return `${ny}-${['03-31', '06-30', '09-30', '12-31'][nq - 1]}`;
}

/**
 * Insert a null point after any gap of more than one quarter in a line, so
 * the plot breaks there instead of drawing a straight line across the years
 * the workbook has no sheet for (2012–2020). Works for { line, date, value }
 * points and for range rows ({ date, low, high, avg }), which have no line.
 */
export function breakGaps(points) {
  const byLine = new Map();
  for (const p of points) {
    const k = p.line ?? '';
    (byLine.get(k) || byLine.set(k, []).get(k)).push(p);
  }
  const out = [];
  for (const [, pts] of byLine) {
    const sorted = [...pts].sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((p, i) => {
      out.push(p);
      const next = sorted[i + 1];
      if (!next) return;
      const gapMonths = (Number(next.date.slice(0, 4)) - Number(p.date.slice(0, 4))) * 12
        + Number(next.date.slice(5, 7)) - Number(p.date.slice(5, 7));
      if (gapMonths > 3) {
        const blank = { ...p, date: nextQuarterEnd(p.date) };
        if ('value' in p) blank.value = null;
        if ('avg' in p) Object.assign(blank, { low: null, high: null, avg: null });
        out.push(blank);
      }
    });
  }
  return out;
}

/** Distinct line labels in first-seen order. */
export function lineLabels(points) {
  const seen = new Set();
  const out = [];
  for (const p of points) if (!seen.has(p.line)) { seen.add(p.line); out.push(p.line); }
  return out;
}

/**
 * Points → the {records, seriesMeta, dashedIds} triple buildIndicatorCard
 * takes. The Average line, when present, draws solid with the rest dashed.
 */
export function toCardInput(chartId, points, { lineOrder = null } = {}) {
  let labels = lineLabels(points);
  if (lineOrder) labels = orderBy(labels, lineOrder);
  if (labels.includes(AVERAGE)) labels = [...labels.filter(l => l !== AVERAGE), AVERAGE];
  const ids = new Map(labels.map(l => [l, `${chartId}:${l}`]));
  // Null-valued points are kept: they are the gap breakers (see breakGaps).
  const records = breakGaps(points).map(p => ({ id: ids.get(p.line), date: p.date, value: p.value }));
  const seriesMeta = labels.map(l => ({
    id: ids.get(l), chartLabel: l, units: 'percent', provider: 'local', frequency: 'quarterly', geo: 'Winnipeg',
  }));
  const dashedIds = labels.includes(AVERAGE) ? labels.filter(l => l !== AVERAGE).map(l => ids.get(l)) : [];
  return { records, seriesMeta, dashedIds };
}

export const fmtRate = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`);
