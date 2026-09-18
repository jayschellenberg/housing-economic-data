/*
 * Cap vs Interest — the top section of the Market Indicators tab.
 *
 * One chart card that always draws the three rate lines an appraiser anchors a
 * cap rate against (BoC overnight target, 5-year and 10-year GoC yields), with
 * optional Winnipeg cap-rate overlays by property type on the same axis. It is
 * the web version of the IntChartALL / IntChartO / IntChartMF family from the
 * "Interest Rate Charts" Quarto project, collapsed into a single card whose
 * overlays are picked with checkboxes rather than baked into 15 separate PNGs.
 *
 * NO CAP-RATE DATA SHIPS WITH THE SITE. The rates come from the committed BoC
 * shard; the cap rates come from a CSV the user loads in their own browser.
 * The parsed per-type averages are kept in localStorage for that browser only —
 * they are never uploaded, never committed, and no other visitor sees them.
 * That is deliberate: the cap-rate source (Colliers' quarterly reports) is not
 * ours to republish. A visitor with no CSV loaded sees the rate lines and an
 * invitation to load one.
 *
 * Both halves are resampled to monthly before plotting. The BoC records are
 * daily (~1,300 points per line over the default 5-year window) and cap rates
 * are quarterly or annual, so without resampling every tooltip would land on a
 * daily rate observation and the cap-rate values would be unreadable. Monthly
 * means are also what the catalog already declares for these series
 * (`transform: monthly_mean`).
 *
 * Wiring: the section renders itself into #mi-chart-grid (see indicators.js,
 * which calls buildCapVsInterest right after buildChartSections so the sidebar
 * picks it up), and re-renders on a date-range change through the exported
 * rerenderCapVsInterest().
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { getPref, setPref } from './prefs.js';

export const CAP_GROUP_ID = 'cap_vs_interest';

// Bumped if the stored shape changes, so an old payload is ignored rather than
// mis-read. v1: { types: {[type]: [[iso, value], …]}, meta, selected }.
const STORAGE_KEY = 'hed.capRates.v1';

// Shared prefs key (prefs.js), not this section's own storage — the firm name
// belongs to whoever is using the site, not to the cap-rate file.
const FIRM_PREF = 'firmName';

// Always drawn, in this order. Series ids are what the committed BoC shard
// (mortgage_market) uses; chartLabel overrides the catalog's terse labels,
// which read fine under "Government of Canada bond yields" but not next to
// "Office CR".
const RATE_LINES = [
  { id: 'boc.policy_target', label: 'BoC overnight target' },
  { id: 'boc.goc_5yr',       label: '5-year GoC yield' },
  { id: 'boc.goc_10yr',      label: '10-year GoC yield' },
];
const RATE_SHARD = 'mortgage_market';

// Cap-rate property types, in the order they should appear. Anything else in
// the CSV's MajorType column is carried through as-is after these.
const KNOWN_TYPES = ['Multi-Family', 'Office', 'Industrial', 'Retail', 'Hotel'];

// The CSV writes both spellings across its history.
const TYPE_ALIASES = { Multifamily: 'Multi-Family', 'Multi Family': 'Multi-Family' };

const REQUIRED_COLUMNS = ['Date', 'MajorType', 'Low', 'High'];

// Module state — one section per page, built once by initIndicators.
let ui = null;

// --- CSV parsing -------------------------------------------------------------

/**
 * Split CSV text into rows of fields, honouring quoted fields (which may
 * contain commas, escaped quotes and newlines) and both CRLF and LF endings.
 * A leading UTF-8 BOM is stripped — Excel writes one, and it would otherwise
 * become part of the first header name.
 */
export function parseCsvRows(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop trailing blank lines.
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

/**
 * Parse the CSV's Date column. The Colliers extract writes MM-DD-YYYY; ISO
 * (YYYY-MM-DD) and MM/DD/YYYY are accepted too so a re-export from Excel with
 * different regional settings still loads. Returns an ISO date string, or null.
 */
export function parseCapDate(raw) {
  const s = String(raw || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Turn CSV text into per-type average cap rates by observation date.
 *
 * Mirrors the CCR_avg step in the Quarto project: normalise the MajorType
 * spelling, take the mid-point of each row's Low–High range, then average the
 * mid-points within a (type, date). Values stay in percent (7.25 → 7.25), which
 * is how every other percent series on this tab is stored.
 *
 * Returns { types, meta } or throws an Error whose message is shown verbatim to
 * the user.
 */
export function parseCapRateCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('That file has no data rows.');

  const header = rows[0].map(h => h.trim());
  const col = {};
  header.forEach((h, i) => { col[h.toLowerCase()] = i; });
  const missing = REQUIRED_COLUMNS.filter(c => col[c.toLowerCase()] === undefined);
  if (missing.length) {
    throw new Error(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
      `Expected the Colliers extract's headers (Source, Market, Date, Quarter, MajorType, PropType, Subtype, Low, High).`);
  }

  const sums = new Map();      // `${type}\u0000${iso}` → { total, n }
  const markets = new Set();
  const sources = new Set();
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const iso  = parseCapDate(r[col.date]);
    const type = normaliseType(r[col.majortype]);
    const low  = rateNumber(r[col.low]);
    const high = rateNumber(r[col.high]);
    // A row needs a date, a type, and at least one of Low/High. Rows with one
    // side blank use the side that is present rather than being dropped.
    const sides = [low, high].filter(Number.isFinite);
    if (!iso || !type || sides.length === 0) { skipped++; continue; }
    const mid = sides.reduce((a, b) => a + b, 0) / sides.length;

    const key = `${type}\u0000${iso}`;
    const cur = sums.get(key) || { total: 0, n: 0 };
    cur.total += mid; cur.n += 1;
    sums.set(key, cur);
    if (col.market !== undefined && r[col.market]?.trim()) markets.add(r[col.market].trim());
    if (col.source !== undefined && r[col.source]?.trim()) sources.add(r[col.source].trim());
  }

  if (sums.size === 0) {
    throw new Error('No rows had a readable Date, MajorType and Low/High. Check the date format (MM-DD-YYYY) and that the rates are numbers.');
  }

  const types = {};
  for (const [key, { total, n }] of sums) {
    const [type, iso] = key.split('\u0000');
    (types[type] ||= []).push([iso, total / n]);
  }
  Object.values(types).forEach(points => points.sort((a, b) => (a[0] < b[0] ? -1 : 1)));

  const allDates = Object.values(types).flat().map(([iso]) => iso).sort();
  return {
    types,
    meta: {
      markets: [...markets],
      sources: [...sources],
      rows: rows.length - 1,
      skipped,
      firstDate: allDates[0],
      lastDate: allDates[allDates.length - 1],
    },
  };
}

/**
 * A Low/High cell as a number, or NaN when the cell is blank. Number('') is 0,
 * which would quietly drag a one-sided range down to half its true mid-point —
 * a blank High must read as "not reported", not as a 0% cap rate.
 */
function rateNumber(raw) {
  const s = String(raw ?? '').replace(/[%\s,]/g, '');
  return s === '' ? NaN : Number(s);
}

/**
 * Who published the cap rates, for the subtitle's source line. Taken from the
 * CSV's Source column so a file from someone other than Colliers is credited
 * correctly rather than mislabelled.
 */
export function capPublisher(sources) {
  const names = (sources || []).map(n => String(n).trim()).filter(Boolean);
  return names.length ? names.join(' & ') : 'a locally loaded file';
}

function normaliseType(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return TYPE_ALIASES[s] || s;
}

/** Known types first (in KNOWN_TYPES order), anything else after, alphabetical. */
export function orderTypes(names) {
  const known = KNOWN_TYPES.filter(t => names.includes(t));
  const extra = names.filter(t => !KNOWN_TYPES.includes(t)).sort();
  return [...known, ...extra];
}

// --- Monthly resampling ------------------------------------------------------

/**
 * Collapse records to one point per calendar month, dated the first of that
 * month. Daily BoC observations become a monthly mean; a quarterly cap-rate
 * observation is the only point in its month, so it survives unchanged apart
 * from moving off the quarter-end day onto the month start (Dec 31 2023 →
 * Dec 2023), which is what the tooltip and data table label it as anyway.
 */
export function monthlyMean(records) {
  const buckets = new Map();
  for (const r of records) {
    if (!Number.isFinite(r.value)) continue;
    const month = String(r.date).slice(0, 7);
    const cur = buckets.get(month) || { total: 0, n: 0 };
    cur.total += r.value; cur.n += 1;
    buckets.set(month, cur);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, { total, n }]) => ({ date: `${month}-01`, value: total / n }));
}

// --- localStorage ------------------------------------------------------------
// Every access is guarded: storage throws in a private window and can come back
// empty after the user clears site data. The section must render either way.

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.types || typeof parsed.types !== 'object') return null;
    return parsed;
  } catch { return null; }
}

function saveStored(payload) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch { /* not fatal */ }
}

function clearStored() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* not fatal */ }
}

// --- Section -----------------------------------------------------------------

function sectionMarkup() {
  return `
    <h2 class="cmhc-mi-section-title">Cap vs Interest</h2>
    <div class="cmhc-cvi-controls border border-neutral-200 rounded bg-neutral-50 p-3 mb-3 text-sm space-y-2">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Cap-rate overlays</span>
        <div data-role="cvi-types" class="flex flex-wrap items-center gap-x-3 gap-y-1"></div>
        <span data-role="cvi-bulk" class="flex items-center gap-2 text-xs" hidden>
          <button type="button" data-role="cvi-all" class="underline">All</button>
          <button type="button" data-role="cvi-none" class="underline">None</button>
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label class="flex items-center gap-2">
          <span class="text-xs text-neutral-600">Firm name</span>
          <input type="text" data-role="cvi-firm" maxlength="60"
                 placeholder="shown under the chart"
                 class="w-52 border border-neutral-300 rounded px-2 py-1 text-xs" />
        </label>
        <label class="flex items-center gap-2">
          <span class="text-xs text-neutral-600">Cap-rate CSV</span>
          <input type="file" data-role="cvi-file" accept=".csv,text/csv"
                 class="text-xs file:mr-2 file:rounded file:border file:border-neutral-300 file:bg-white file:px-2 file:py-1 file:text-xs" />
        </label>
        <button type="button" data-role="cvi-clear"
                class="text-xs underline text-neutral-600" hidden>Remove loaded data</button>
      </div>
      <p data-role="cvi-status" class="text-xs text-neutral-600"></p>
      <p data-role="cvi-error" class="text-xs text-red-700" hidden></p>
    </div>
    <div data-role="cvi-card-grid" class="grid md:grid-cols-2 gap-4"></div>
  `;
}

/**
 * Build the section and its card.
 *
 * @param {Object} shards    the loaded indicator shards, keyed by group
 * @param {Object} rangeRef  live view of the tab's date range —
 *                           { monthFrom, monthTo } read at each render
 */
export function buildCapVsInterest(shards, rangeRef) {
  const $grid = document.getElementById('mi-chart-grid');
  if (!$grid) return;

  const shard = shards?.[RATE_SHARD];
  // Without the BoC shard there is no chart to draw and nothing a CSV could
  // rescue — skip the section entirely rather than render an empty frame.
  if (!shard?.records?.length) return;

  const rateMeta = RATE_LINES
    .map(({ id, label }) => {
      const meta = (shard.series || []).find(s => s.id === id);
      return meta ? { ...meta, chartLabel: label, frequency: 'monthly' } : null;
    })
    .filter(Boolean);
  if (rateMeta.length === 0) return;

  const rateIds = new Set(rateMeta.map(s => s.id));
  // Resample once: the shard's daily records don't change, only the window does.
  const rateRecords = [];
  for (const s of rateMeta) {
    const own = shard.records.filter(r => r.id === s.id);
    monthlyMean(own).forEach(p => rateRecords.push({ id: s.id, date: p.date, value: p.value }));
  }

  const section = document.createElement('section');
  section.className = 'cmhc-mi-section';
  section.dataset.group = CAP_GROUP_ID;
  section.id = `mi-section-${CAP_GROUP_ID}`;
  section.innerHTML = sectionMarkup();
  // Top of the page, above the catalog-driven sections.
  $grid.prepend(section);

  const $types  = section.querySelector('[data-role="cvi-types"]');
  const $bulk   = section.querySelector('[data-role="cvi-bulk"]');
  const $file   = section.querySelector('[data-role="cvi-file"]');
  const $clear  = section.querySelector('[data-role="cvi-clear"]');
  const $status = section.querySelector('[data-role="cvi-status"]');
  const $error  = section.querySelector('[data-role="cvi-error"]');
  const $cardGrid = section.querySelector('[data-role="cvi-card-grid"]');
  const $firm     = section.querySelector('[data-role="cvi-firm"]');

  let stored = loadStored();

  ui = {
    section, $types, $bulk, $file, $clear, $status, $error, $cardGrid,
    rateMeta, rateRecords, rateIds, rangeRef,
    get stored() { return stored; },
    set stored(v) { stored = v; },
    card: null,
  };

  // The firm name signs the chart (and so the exported PNG). Kept in the
  // shared per-browser prefs rather than this section's own storage: it is a
  // property of whoever is using the site, not of the cap-rate file.
  $firm.value = getPref(FIRM_PREF) || '';
  $firm.addEventListener('change', () => {
    setPref(FIRM_PREF, $firm.value.trim());
    renderCard();
  });

  renderControls();
  renderCard();

  $file.addEventListener('change', async () => {
    const file = $file.files?.[0];
    if (!file) return;
    showError('');
    try {
      const text = await file.text();
      const { types, meta } = parseCapRateCsv(text);
      const names = orderTypes(Object.keys(types));
      stored = {
        types,
        meta: { ...meta, filename: file.name, loadedAt: new Date().toISOString() },
        selected: names,          // a fresh file starts with every type shown
      };
      saveStored(stored);
      renderControls();
      renderCard();
    } catch (err) {
      showError(err?.message || 'That file could not be read as a cap-rate CSV.');
    } finally {
      // Let the same file be picked again after a fix — `change` doesn't fire
      // twice for an unchanged value.
      $file.value = '';
    }
  });

  $clear.addEventListener('click', () => {
    clearStored();
    stored = null;
    showError('');
    renderControls();
    renderCard();
  });

  section.querySelector('[data-role="cvi-all"]').addEventListener('click', () => setAll(true));
  section.querySelector('[data-role="cvi-none"]').addEventListener('click', () => setAll(false));

  function setAll(on) {
    if (!stored) return;
    stored.selected = on ? orderTypes(Object.keys(stored.types)) : [];
    saveStored(stored);
    renderControls();
    renderCard();
  }

  function showError(msg) {
    $error.textContent = msg;
    $error.hidden = !msg;
  }

  function renderControls() {
    $types.replaceChildren();
    const has = stored && Object.keys(stored.types).length > 0;
    $bulk.hidden = !has;
    $clear.hidden = !has;

    if (!has) {
      const hint = document.createElement('span');
      hint.className = 'text-xs text-neutral-500';
      hint.textContent = 'Load a cap-rate CSV to overlay cap rates on the rate lines.';
      $types.appendChild(hint);
      $status.textContent =
        'No cap-rate data is published with this site. Load a CSV below and it stays in this browser only — ' +
        'it is not uploaded, and nobody else sees it.';
      return;
    }

    const names = orderTypes(Object.keys(stored.types));
    const selected = new Set(stored.selected || names);
    names.forEach(type => {
      const label = document.createElement('label');
      label.className = 'flex items-center gap-1 text-sm';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(type);
      cb.dataset.type = type;
      cb.addEventListener('change', () => {
        const next = new Set(stored.selected || names);
        if (cb.checked) next.add(type); else next.delete(type);
        stored.selected = orderTypes([...next]);
        saveStored(stored);
        renderCard();
      });
      const text = document.createElement('span');
      text.textContent = type;
      label.append(cb, text);
      $types.appendChild(label);
    });

    const m = stored.meta || {};
    const where = m.markets?.length ? m.markets.join(', ') : 'unknown market';
    const who = m.sources?.length ? m.sources.join(', ') : 'unknown source';
    const span = m.firstDate && m.lastDate ? `${m.firstDate} to ${m.lastDate}` : 'unknown period';
    $status.textContent =
      `${who} — ${where}. ${m.rows ?? 0} rows, ${span}` +
      `${m.skipped ? `, ${m.skipped} unreadable row${m.skipped > 1 ? 's' : ''} skipped` : ''}. ` +
      `From ${m.filename || 'a local file'}, held in this browser only.`;
  }

  function renderCard() {
    // The card is rebuilt rather than re-rendered because the series set
    // changes with the checkboxes; carry the open panels across so a data
    // table the user just opened doesn't close under them (same reason the
    // Agriculture tab does this).
    const open = readOpenPanels(ui.card?.card);
    $cardGrid.replaceChildren();

    const capTypes = stored ? orderTypes(stored.selected || []).filter(t => stored.types[t]?.length) : [];
    const capMeta = capTypes.map(type => {
      const points = stored.types[type];
      const last = points[points.length - 1];
      return {
        id: `cap.${type}`,
        provider: 'local',
        // 'Retail CR', as the reference chart's legend abbreviates it. This is
        // the series label everywhere — legend, hover tip, latest-value chips and
        // the data table's column heading — so they all read the same.
        chartLabel: `${type} CR`,
        units: 'percent',
        frequency: 'quarterly',
        geo: (stored.meta?.markets || [])[0] || 'local',
        latestDate: last[0],
        latestValue: last[1],
      };
    });
    const capRecords = capTypes.flatMap(type =>
      stored.types[type].map(([iso, value]) => ({
        id: `cap.${type}`,
        // Snap onto the month start so the point shares an x with that month's
        // rate observations and the tooltip reads out both together.
        date: `${String(iso).slice(0, 7)}-01`,
        value,
      })));

    // The source rides in the subtitle (see the render call below), so the
    // caption row is suppressed rather than repeating it under the chart.

    const card = buildIndicatorCard($cardGrid, {
      chartId: 'cap_vs_interest',
      // Not CMHC data — export without the shared cmhc_ prefix.
      fileStem: 'cap_vs_interest',
      // Titles as the reference appraisal chart words them (the Quarto
      // project's COMBO_TITLE and its rates-only chart).
      title: capTypes.length
        ? 'Overnight, 5-Year, 10-Year Yields & Cap Rates'
        : 'Canadian Rate Environment',
      sourceLabel: null,
      captionRight: (getPref(FIRM_PREF) || '').trim() || null,
      table: true,
      description:
        'The BoC overnight target with the 5- and 10-year Government of Canada yields — the ' +
        'benchmarks a cap rate is built off — and, when a cap-rate CSV is loaded, the average ' +
        'cap rate by property type on the same axis. The gap between a cap rate and the 5-year ' +
        'GoC is the risk premium the market is pricing; watching it widen or compress is the ' +
        'point of putting the two on one chart. Rate lines are monthly means of the daily BoC ' +
        'series; cap rates are the mid-point of each reported Low–High range, averaged across ' +
        'the reported classes and subtypes for that property type and period. Cap-rate data is ' +
        'read from a file in your browser and is not published with this site.',
    });

    const seriesMeta = [...ui.rateMeta, ...capMeta];
    const records = [...ui.rateRecords, ...capRecords];
    const { monthFrom, monthTo } = ui.rangeRef;
    card.render(records, seriesMeta, {
      // "Aug-2021 to Aug-2026; Source: …", matching the reference chart's
      // subtitle (its date_range + COMBINED / BOC_SHORT source line).
      rangePrefix: true,
      subtitle: capTypes.length
        ? `Source: Bank of Canada & ${capPublisher(stored.meta?.sources)} Average Cap Rates (CR)`
        : 'Source: Bank of Canada',
      monthFrom,
      monthTo,
    });
    card.setOpenPanels(open);
    ui.card = card;
  }

  ui.renderCard = renderCard;
}

/** Re-render on a date-range change (called from indicators.js rerenderCards). */
export function rerenderCapVsInterest() {
  ui?.renderCard?.();
}
