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
 * shard; the cap rates are the SAME local data the Cap Rates tab reads — the
 * firm's cap_rates.json in the SharedInfo\Apps\CapRates folder, held in this
 * browser's IndexedDB by cap-rates-store.js. Picking that folder once on the
 * Cap Rates tab serves both tabs, so there is one cap-rate source to
 * maintain. (An earlier version took a separate Colliers CSV here; that path
 * is gone.) A visitor with no folder loaded sees the rate lines and a pointer
 * to the Cap Rates tab.
 *
 * The overlay for a property type is the mean of one firm's class mid-points
 * that quarter (Office = all four downtown/suburban classes together), for
 * the firm chosen in the section — Colliers by default — or the mean across
 * all three firms.
 *
 * Both halves are resampled to monthly before plotting. The BoC records are
 * daily (~1,300 points per line over the default 5-year window) and cap rates
 * are quarterly, so without resampling every tooltip would land on a daily
 * rate observation and the cap-rate values would be unreadable. Monthly means
 * are also what the catalog already declares for these series
 * (`transform: monthly_mean`).
 *
 * Wiring: the section renders itself into the container it is given — the
 * Cap Rates vs Interest tab's #cvi-grid (cap-vs-interest-tab.js) — and
 * re-renders on a date-range change through the exported
 * rerenderCapVsInterest(). It also re-reads the store when the Cap Rates tab
 * announces a fresh import (the 'hed:cap-rates-updated' window event).
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { getPref, setPref } from './prefs.js';
import { getData as getCapRatesData, storeAvailable } from './cap-rates-store.js';

export const CAP_GROUP_ID = 'cap_vs_interest';
export const CAP_RATES_UPDATED_EVENT = 'hed:cap-rates-updated';

// Section preferences (firm + which overlays are on), per browser. v2: the
// v1 key held the parsed CSV itself and is simply ignored now.
const PREF_KEY = 'capVsInterest.v2';

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

// Colours from the reference chart's SOURCE_STYLE, as close as the web can get
// to the R colour names it uses. They are not decorative: an appraiser reading
// these charts expects office blue, retail red, industrial grey and
// multi-family green, and the two bond yields in the blue/purple pair.
//
// Industrial is the one deliberate departure — R's "darkgrey" (#A9A9A9) is so
// light on white that the line is hard to follow, so it is darkened a step.
const RATE_COLOURS = {
  'boc.policy_target': '#36648B',   // steelblue4
  'boc.goc_5yr':       '#7D26CD',   // purple3
  'boc.goc_10yr':      '#5CACEE',   // steelblue2 (light blue)
};
const CAP_COLOURS = {
  'Multi-Family': '#228B22',        // forestgreen — a step up from the
                                    // reference's darkgreen, which reads almost
                                    // black at this line weight
  'Office':       '#0000FF',        // blue
  'Industrial':   '#8C8C8C',        // darkgrey, a step darker for legibility
  'Retail':       '#8B0000',        // darkred
  'Hotel':        '#CD8500',        // orange3 — not in the reference scheme
  'Self Storage': '#8B4789',        // orchid4 — not in the reference scheme
};

// Cap-rate property types, in the order they should appear. Anything else in
// the data is carried through as-is after these.
export const KNOWN_TYPES = ['Multi-Family', 'Office', 'Industrial', 'Retail', 'Hotel', 'Self Storage'];

// Available but off until asked for. The reference chart never plots hotel
// cap rates, and hotel and self storage are thinner series than the four
// core types; "All" still turns them on.
export const DEFAULT_OFF_TYPES = new Set(['Hotel', 'Self Storage']);

export const FIRMS = ['Colliers', 'CBRE', 'Cushman & Wakefield'];
export const ALL_FIRMS = 'average';
export const DEFAULT_FIRM = 'Colliers';

// Module state — one section per page, built once by initIndicators.
let ui = null;

// --- Cap-rate series from the shared store -----------------------------------

/**
 * Per-type average cap rates by quarter from the Cap Rates tab's rows
 * ({ date, firm, type, subtype, mid } with mid as a fraction).
 *
 * For one firm: the mean of that firm's class mid-points within a (type,
 * quarter) — Office is all four downtown/suburban classes together, which is
 * how the earlier CSV path averaged "MajorType". For ALL_FIRMS: the mean of
 * every firm's class mid-points. Values come out in percent (0.0725 → 7.25),
 * which is how every other percent series on this tab is stored.
 *
 * Returns { types: {[type]: [[iso, value], …]}, firstDate, lastDate }.
 */
export function capSeriesFromRows(rows, firm = DEFAULT_FIRM) {
  const sums = new Map();      // `${type}\u0000${iso}` → { total, n }
  for (const r of rows || []) {
    if (!r || typeof r.mid !== 'number' || !Number.isFinite(r.mid)) continue;
    if (firm !== ALL_FIRMS && r.firm !== firm) continue;
    if (!r.type || !r.date) continue;
    const key = `${r.type}\u0000${r.date}`;
    const cur = sums.get(key) || { total: 0, n: 0 };
    cur.total += r.mid * 100; cur.n += 1;
    sums.set(key, cur);
  }
  const types = {};
  for (const [key, { total, n }] of sums) {
    const [type, iso] = key.split('\u0000');
    (types[type] ||= []).push([iso, total / n]);
  }
  Object.values(types).forEach(points => points.sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const allDates = Object.values(types).flat().map(([iso]) => iso).sort();
  return { types, firstDate: allDates[0] || null, lastDate: allDates[allDates.length - 1] || null };
}

/** Known types first (in KNOWN_TYPES order), anything else after, alphabetical. */
export function orderTypes(names) {
  const known = KNOWN_TYPES.filter(t => names.includes(t));
  const extra = names.filter(t => !KNOWN_TYPES.includes(t)).sort();
  return [...known, ...extra];
}

/** How the subtitle credits the cap rates for a firm choice. */
export function capPublisher(firm) {
  if (firm === ALL_FIRMS) return 'Colliers, CBRE & Cushman & Wakefield (average)';
  return firm || DEFAULT_FIRM;
}

/** The cap-rate publisher as the caption names it: "Colliers Canada". */
function captionPublisher(firm) {
  if (firm === ALL_FIRMS) return 'Colliers Canada, CBRE & Cushman & Wakefield';
  const f = firm || DEFAULT_FIRM;
  return f === 'Colliers' ? 'Colliers Canada' : f;
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

// --- Preferences -------------------------------------------------------------

function loadPrefs() {
  const p = getPref(PREF_KEY);
  return p && typeof p === 'object' ? p : {};
}
function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  setPref(PREF_KEY, next);
  return next;
}

// --- Section -----------------------------------------------------------------

// The firm + overlay pickers. In a tab sidebar (the Cap Rates vs Interest tab
// passes `controls`) they read as ordinary sidebar sections; beside the card
// they sit in a light box.
function controlsMarkup(inSidebar) {
  const title = 'text-xs font-semibold text-neutral-500 uppercase tracking-wider';
  return `
    <div class="${inSidebar ? 'space-y-4' : 'cmhc-cvi-controls border border-neutral-200 rounded bg-neutral-50 p-3 text-sm space-y-3 min-w-0'}">
      <section class="space-y-1">
        <h2 class="block ${title}${inSidebar ? ' mb-2' : ''}">Cap-rate source</h2>
        <label class="flex items-center gap-2 text-sm">Firm
          <select data-role="cvi-firm" class="${inSidebar ? 'flex-1 ' : ''}border border-neutral-300 rounded px-2 py-1 text-sm"></select>
        </label>
      </section>
      <section class="space-y-1">
        <div class="flex items-baseline justify-between gap-2${inSidebar ? ' mb-2' : ''}">
          <h2 class="${title}">Cap-rate overlays</h2>
          <span data-role="cvi-bulk" class="flex items-center gap-2 text-xs" hidden>
            <button type="button" data-role="cvi-all" class="underline">All</button>
            <button type="button" data-role="cvi-none" class="underline">None</button>
          </span>
        </div>
        <div data-role="cvi-types" class="grid gap-1 text-sm"></div>
      </section>
      <p data-role="cvi-status" class="text-xs text-neutral-600"></p>
    </div>
  `;
}

function sectionMarkup(controlsElsewhere) {
  return `
    <h2 class="cmhc-mi-section-title">Cap vs Interest</h2>
    <!-- Chart left, its controls in the column beside it (or, on the Cap
         Rates vs Interest tab, in the sidebar with the date range) — the card
         keeps half of a two-column grid either way, like every other card. -->
    <div class="grid md:grid-cols-2 gap-4 items-start">
      <div data-role="cvi-card-grid" class="min-w-0"></div>
      ${controlsElsewhere ? '' : controlsMarkup(false)}
    </div>
  `;
}

/**
 * Build the section and its card.
 *
 * @param {Object} shards    the loaded indicator shards, keyed by group
 * @param {Object} rangeRef  live view of the tab's date range —
 *                           { monthFrom, monthTo } read at each render
 * @param {Object} [opts]
 * @param {string} [opts.container]  selector of the element to render into
 * @param {string} [opts.controls]   selector of a sidebar element to hold the
 *                                   firm + overlay pickers (default: beside the card)
 */
export function buildCapVsInterest(shards, rangeRef, { container = '#cvi-grid', controls } = {}) {
  const $grid = document.querySelector(container);
  if (!$grid) return;

  const shard = shards?.[RATE_SHARD];
  // Without the BoC shard there is no chart to draw and nothing the cap rates
  // could rescue — skip the section entirely rather than render an empty frame.
  if (!shard?.records?.length) return;

  const rateMeta = RATE_LINES
    .map(({ id, label }) => {
      const meta = (shard.series || []).find(s => s.id === id);
      return meta ? { ...meta, chartLabel: label, frequency: 'monthly' } : null;
    })
    .filter(Boolean);
  if (rateMeta.length === 0) return;

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
  const $controlsHost = controls ? document.querySelector(controls) : null;
  section.innerHTML = sectionMarkup(Boolean($controlsHost));
  $grid.appendChild(section);
  if ($controlsHost) $controlsHost.innerHTML = controlsMarkup(true);
  const ctl = $controlsHost || section;

  const $firm   = ctl.querySelector('[data-role="cvi-firm"]');
  const $types  = ctl.querySelector('[data-role="cvi-types"]');
  const $bulk   = ctl.querySelector('[data-role="cvi-bulk"]');
  const $status = ctl.querySelector('[data-role="cvi-status"]');
  const $cardGrid = section.querySelector('[data-role="cvi-card-grid"]');

  let prefs = loadPrefs();
  let rows = null;          // the Cap Rates tab's rows, or null when not loaded
  let series = { types: {}, firstDate: null, lastDate: null };

  ui = { section, rateMeta, rateRecords, rangeRef, card: null };

  for (const [value, label] of [...FIRMS.map(f => [f, f]), [ALL_FIRMS, 'Average of all firms']]) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = label;
    $firm.appendChild(opt);
  }
  $firm.value = FIRMS.includes(prefs.firm) || prefs.firm === ALL_FIRMS ? prefs.firm : DEFAULT_FIRM;
  $firm.addEventListener('change', () => {
    prefs = savePrefs({ firm: $firm.value });
    recompute();
    renderControls();
    renderCard();
  });

  ctl.querySelector('[data-role="cvi-all"]').addEventListener('click', () => setAll(true));
  ctl.querySelector('[data-role="cvi-none"]').addEventListener('click', () => setAll(false));

  function selectedTypes() {
    const names = orderTypes(Object.keys(series.types));
    if (Array.isArray(prefs.selected)) return names.filter(t => prefs.selected.includes(t));
    return names.filter(t => !DEFAULT_OFF_TYPES.has(t));
  }

  function setAll(on) {
    prefs = savePrefs({ selected: on ? orderTypes(Object.keys(series.types)) : [] });
    renderControls();
    renderCard();
  }

  function recompute() {
    series = rows ? capSeriesFromRows(rows, $firm.value) : { types: {}, firstDate: null, lastDate: null };
  }

  function renderControls() {
    $types.replaceChildren();
    const has = Object.keys(series.types).length > 0;
    $bulk.hidden = !has;

    if (!has) {
      const hint = document.createElement('span');
      hint.className = 'text-xs text-neutral-500';
      hint.textContent = rows
        ? 'No cap-rate rows for this firm.'
        : 'Load the CapRates folder on the Cap Rates tab to overlay cap rates on the rate lines.';
      $types.appendChild(hint);
      $status.textContent = rows
        ? 'The loaded cap-rate data has no rows for the chosen firm.'
        : 'No cap-rate data is published with this site. It is read from the same local folder the ' +
          'Cap Rates tab uses (Local Data › Cap Rates › Choose folder) and stays in this browser only.';
      return;
    }

    const names = orderTypes(Object.keys(series.types));
    const selected = new Set(selectedTypes());
    names.forEach(type => {
      const label = document.createElement('label');
      label.className = 'flex items-center gap-1 text-sm';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(type);
      cb.dataset.type = type;
      cb.addEventListener('change', () => {
        const next = new Set(selectedTypes());
        if (cb.checked) next.add(type); else next.delete(type);
        prefs = savePrefs({ selected: orderTypes([...next]) });
        renderCard();
      });
      const text = document.createElement('span');
      text.textContent = type;
      label.append(cb, text);
      $types.appendChild(label);
    });

    const span = series.firstDate && series.lastDate ? `${series.firstDate} to ${series.lastDate}` : 'unknown period';
    $status.textContent =
      `${capPublisher($firm.value)} — Winnipeg, ${span}. ` +
      'Mean of the published class mid-points per quarter, from the Cap Rates tab’s local data; not published with this site.';
  }

  function renderCard() {
    // The card is rebuilt rather than re-rendered because the series set
    // changes with the checkboxes; carry the open panels across so a data
    // table the user just opened doesn't close under them (same reason the
    // Agriculture tab does this).
    const open = readOpenPanels(ui.card?.card);
    $cardGrid.replaceChildren();

    const capTypes = selectedTypes().filter(t => series.types[t]?.length);
    const capMeta = capTypes.map(type => {
      const points = series.types[type];
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
        geo: 'Winnipeg',
        latestDate: last[0],
        latestValue: last[1],
      };
    });
    const capRecords = capTypes.flatMap(type =>
      series.types[type].map(([iso, value]) => ({
        id: `cap.${type}`,
        // Snap onto the month start so the point shares an x with that month's
        // rate observations and the tooltip reads out both together.
        date: `${String(iso).slice(0, 7)}-01`,
        value,
      })));

    const card = buildIndicatorCard($cardGrid, {
      chartId: 'cap_vs_interest',
      // Not CMHC data — export without the shared cmhc_ prefix.
      fileStem: 'cap_vs_interest',
      // Heavier than the other indicator cards, as on the reference chart.
      lineWidth: 3.6,
      // Titles as the reference appraisal chart words them (the Quarto
      // project's COMBO_TITLE and its rates-only chart).
      title: capTypes.length
        ? 'Overnight, 5-Year, 10-Year Yields & Cap Rates'
        : 'Canadian Rate Environment',
      // "Source: Bank of Canada & Colliers Canada Average Cap Rates" in the
      // caption, bottom-right; 10 pt in print, as on the other Local Data
      // tabs (Jason, 2026-09-30).
      sourceLabel: capTypes.length
        ? `Bank of Canada & ${captionPublisher($firm.value)} Average Cap Rates`
        : 'Bank of Canada',
      sourceInCaption: true,
      captionPt: 10,
      table: true,
      zeroBased: true,
      description:
        'The BoC overnight target with the 5- and 10-year Government of Canada yields — the ' +
        'benchmarks a cap rate is built off — and, when the Cap Rates folder is loaded, the average ' +
        'cap rate by property type on the same axis. The gap between a cap rate and the 5-year ' +
        'GoC is the risk premium the market is pricing; watching it widen or compress is the ' +
        'point of putting the two on one chart. Rate lines are monthly means of the daily BoC ' +
        'series; cap rates are the chosen firm’s published Low–High mid-points averaged ' +
        'across that property type’s classes for the quarter (or across all firms). The ' +
        'cap-rate data is the same local file the Cap Rates tab reads and is not published with this site.',
    });

    const seriesMeta = [...ui.rateMeta, ...capMeta];
    const records = [...ui.rateRecords, ...capRecords];
    const { monthFrom, monthTo } = ui.rangeRef;
    card.render(records, seriesMeta, {
      // "Aug-2021 to Aug-2026; Bank of Canada Interest Rates & Bond Yields vs
      // Capitalization Rates (CR)": the timeframe, then what the chart
      // compares (CR is the legend's abbreviation).
      rangePrefix: true,
      subtitle: capTypes.length
        ? 'Bank of Canada Interest Rates & Bond Yields vs Capitalization Rates (CR)'
        : 'Bank of Canada Interest Rates & Bond Yields',
      // Cap rates dashed, interest rates solid — as on the reference chart,
      // where the distinction matters more than colour alone at a glance.
      dashedIds: capMeta.map(s => s.id),
      seriesColours: {
        ...RATE_COLOURS,
        ...Object.fromEntries(capTypes
          .filter(t => CAP_COLOURS[t])
          .map(t => [`cap.${t}`, CAP_COLOURS[t]])),
      },
      monthFrom,
      monthTo,
    });
    card.setOpenPanels(open);
    ui.card = card;
  }

  async function loadRows() {
    if (!storeAvailable()) { rows = null; return; }
    try {
      const data = await getCapRatesData();
      rows = Array.isArray(data?.rows) ? data.rows : null;
    } catch { rows = null; }
  }

  async function refresh() {
    await loadRows();
    recompute();
    renderControls();
    renderCard();
  }

  ui.renderCard = renderCard;
  ui.refresh = refresh;

  // First paint without waiting on IndexedDB, then fill in the overlays.
  renderControls();
  renderCard();
  refresh();
  // The Cap Rates tab announces a fresh import; pick it up without a reload.
  window.addEventListener(CAP_RATES_UPDATED_EVENT, () => { refresh(); });
}

/** Re-render on a date-range change (called from indicators.js rerenderCards). */
export function rerenderCapVsInterest() {
  ui?.renderCard?.();
}
