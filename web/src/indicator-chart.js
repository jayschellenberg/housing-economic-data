/*
 * Indicator chart panel — a sibling of chart.js purpose-built for the
 * Market Indicators tab. Key differences from the rental/Scss charts:
 *
 *   - X axis is ISO date (a real time scale), not integer year
 *   - Per-series unit formatter from the catalog (percent / dollar /
 *     index / balance_of_opinion)
 *   - Per-series source label below the chart (not hardcoded CMHC)
 *   - "Last value (as of …)" badge inside the card
 *   - Stale-data warning band when the most recent observation is older
 *     than the freshness threshold for the series's frequency
 *
 * Reuses the dark-red title + dashed grid + framed plot styling from the
 * existing chart cards via the same .chart-card CSS class.
 */

import * as Plot from '@observablehq/plot';
import { toPng } from 'html-to-image';
import { themed, PALETTE, gridMarks, frameMark } from './plot-theme.js';
import { escapeHtml } from './escape.js';
import { INDICATOR_FMT as FMT, indicatorFmt as fmt } from './format.js';

// --- Formatters --------------------------------------------------------------
// Permits raw values are dollars and span 6-10 figures; render as $M.
function pickFormatter(units, values) {
  if (units === 'dollar') {
    const max = Math.max(...values.filter(Number.isFinite));
    if (max >= 1e6) return FMT.dollar_millions;
  }
  return fmt(units);
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Reference band / line colour (BoC inflation-control range). Deliberately not
// from PALETTE — it must read as annotation, never as another data series.
const REF_COLOUR = '#0f766e';
// House convention for a missing observation in a table (see the other tabs).
const MISSING = '**';

// Period label for the hover tooltip and the data table, matched to how the
// series is published: a monthly CPI observation reads as "May 2023", a
// quarterly one as "Q2 2023", an annual average as "2023", and daily/weekly
// rates keep the day. Dates are parsed UTC, so read them in UTC.
export function periodLabel(d, frequency) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (frequency === 'annual')    return String(y);
  if (frequency === 'quarterly') return `Q${Math.floor(m / 3) + 1} ${y}`;
  if (frequency === 'monthly')   return `${MONTH_ABBR[m]} ${y}`;
  return `${d.getUTCDate()} ${MONTH_ABBR[m]} ${y}`;
}

/**
 * Y-axis domain for a chart panel.
 *
 * Positive-only series keep the axis anchored at (or near) zero, which is how
 * every level indicator on this tab reads. Series that legitimately go below
 * zero must not be clamped there: the SLOS balance of opinion by definition,
 * and any rate-of-change series that actually printed negative in the window —
 * CPI inflation did in mid-2020, and NHPI / BCPI / wage YoY can too. A clamped
 * axis would draw those points outside the frame.
 *
 * A reference band or line is pulled inside the domain as well; a 1-3% target
 * band is useless if the axis crops it out when inflation runs hot.
 */
export function yDomainFor(values, { balanceOfOpinion = false, refBand, refLine } = {}) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return [0, 1];
  const dataMin = Math.min(...finite);
  const dataMax = Math.max(...finite);
  const allowsNegative = balanceOfOpinion || dataMin < 0;
  const pad = Math.max(0.05 * (dataMax - dataMin), 0.01);
  let lo = allowsNegative ? Math.min(0, dataMin - pad) : Math.max(0, dataMin - pad);
  let hi = allowsNegative ? Math.max(0, dataMax + pad) : dataMax + pad;
  if (refBand) { lo = Math.min(lo, refBand.from); hi = Math.max(hi, refBand.to); }
  if (refLine) { lo = Math.min(lo, refLine.at);   hi = Math.max(hi, refLine.at); }
  return [lo, hi];
}

/**
 * Group plotted points by period and build one tooltip row each, so hovering
 * anywhere in a month reads out every visible line at that month
 * ("May 2023 / Canada: 3.40% / Manitoba: 3.45%") rather than a single point.
 * The row is anchored at the mid-point of that period's values so the tip
 * lands near the lines. Returns rows sorted oldest → newest.
 */
export function buildTipRows(points, frequency, formatter) {
  const byPeriod = new Map();
  points.forEach(p => {
    const key = p.date.getTime();
    if (!byPeriod.has(key)) byPeriod.set(key, { date: p.date, entries: [] });
    byPeriod.get(key).entries.push(p);
  });
  return [...byPeriod.values()]
    .sort((a, b) => a.date - b.date)
    .map(({ date, entries }) => {
      const nums = entries.map(e => e.value).filter(Number.isFinite);
      return {
        date,
        entries,
        anchor: nums.length ? (Math.min(...nums) + Math.max(...nums)) / 2 : 0,
        text: [periodLabel(date, frequency),
               ...entries.map(e => `${e.label}: ${formatter(e.value)}`)].join('\n'),
      };
    });
}

/**
 * Fill the collapsible data table: one row per period (newest first), one
 * column per visible series. Returns the same grid as TSV for the copy button.
 * Built with DOM nodes rather than an HTML string — series labels and values
 * are never string-injected.
 *
 * Called on demand (see the deferred build in `render`), not on every chart
 * render: the Agriculture tab defaults to the full history, so monthly crop
 * prices alone would be ~500 rows per card that nobody has asked to see.
 */
export function renderDataTable($wrap, periods, seriesMeta, frequency, yFormatter) {
  const labels = seriesMeta.map(s => s.chartLabel || s.id);
  const table = document.createElement('table');
  table.className = 'cmhc-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Period', ...labels].forEach(text => {
    const th = document.createElement('th');
    th.textContent = text;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  const grid = [['Period', ...labels]];
  [...periods].reverse().forEach(({ date, entries }) => {
    const byLabel = new Map(entries.map(e => [e.label, e.value]));
    const period = periodLabel(date, frequency);
    const tr = document.createElement('tr');
    const first = document.createElement('td');
    first.textContent = period;
    tr.appendChild(first);
    const line = [period];
    labels.forEach(label => {
      const v = byLabel.get(label);
      const ok = Number.isFinite(v);
      const td = document.createElement('td');
      td.textContent = ok ? yFormatter(v) : MISSING;
      if (!ok) td.className = 'cmhc-table-na';
      tr.appendChild(td);
      line.push(ok ? yFormatter(v) : MISSING);
    });
    tbody.appendChild(tr);
    grid.push(line);
  });
  table.append(thead, tbody);
  $wrap.replaceChildren(table);
  return grid.map(row => row.join('\t')).join('\n');
}

/**
 * The card's collapsible panels, by key. A tab that keeps its cards (Market
 * Indicators) never needs these — the open state survives a re-render on its
 * own. A tab that discards and rebuilds its cards on every control change
 * (Agriculture) must snapshot what was open with `readOpenPanels(cardEl)`
 * before the wipe and hand it to the new card's `setOpenPanels`, or the panel
 * the user just opened to read closes under them.
 */
const PANEL_SELECTORS = { table: '.cmhc-chart-table', explainer: '.cmhc-explainer' };

export function readOpenPanels(cardEl) {
  if (!cardEl) return [];
  return Object.entries(PANEL_SELECTORS)
    .filter(([, selector]) => cardEl.querySelector(`${selector}[open]`))
    .map(([key]) => key);
}

// Copy the table as TSV — pastes into Excel or Word as real columns.
async function copyTsv($btn, tsv) {
  const original = $btn.textContent;
  try {
    await navigator.clipboard.writeText(tsv);
    $btn.textContent = 'Copied';
  } catch (err) {
    console.error('[indicator-chart copy]', err);
    $btn.textContent = 'Copy failed';
  }
  setTimeout(() => { $btn.textContent = original; }, 1600);
}

// Freshness thresholds in days, by frequency. Each threshold combines the
// publisher's typical release lag and a generous buffer for our monthly
// refresh cadence — so the "stale" banner fires only when something is
// genuinely behind, not when the upstream just hasn't released yet.
//
//   daily      — BoC publishes overnight; 7-day flex covers weekends + holidays
//   weekly     — posted mortgage rates are weekly; 3-week flex covers holidays
//   monthly    — StatsCan monthly series lag 3 weeks to 3 months (SEPH is the
//                slowest); 130 days covers SEPH's worst case + buffer
//   quarterly  — typical 6-12 week lag; 270 days covers ~3 months pub lag +
//                6-month buffer between our monthly refreshes
//   annual     — CMHC RMS October data publishes ~Feb of next year
//   irregular  — BoC policy rate decisions: only ~8/year by schedule, plus
//                emergency calls. 540 days = "two scheduled-decision cycles
//                without a single move" — definitely a refresh-broke signal
const FRESHNESS_DAYS = {
  daily:     7,
  weekly:    21,
  monthly:   130,
  quarterly: 270,
  annual:    540,
  irregular: 540,
};

// Per-chart freshness overrides (days), keyed by chartId. Use when a chart's
// real-world publish cadence doesn't match its series' nominal frequency.
// Posted mortgage rates: BoC posts the conventional rates weekly (Wednesdays)
// and the broker variable line lags a few days, so the daily/weekly defaults
// flag false staleness mid-cycle. 15 days covers the normal weekly cycle plus
// buffer — the chart only warns if a rate is genuinely more than ~2 weeks old.
// GoC bond yields: BoC publishes them daily but we pull them on the weekly
// indicators refresh, so the 7-day "daily" default false-flags late each cycle;
// 15 days covers the normal weekly cadence (warns only if a refresh truly broke).
const FRESHNESS_OVERRIDE_DAYS = {
  mortgage_rates:     15,
  goc_yields:         15,
  cap_rate_pressure:  15,   // derived from the 5-yr GoC yield — same weekly cadence
  // Annual-average inflation is dated Jan 1 of the year it describes and only
  // lands once that year's December CPI publishes, so the newest point is
  // legitimately ~12 months old the day it appears and ~24 months old the day
  // before its successor arrives. 800 days covers that full cycle; the default
  // 540 would flag a perfectly current series as stale for half of every year.
  cpi_inflation_annual: 800,
};

/**
 * Build an indicator chart panel and append it to `container`.
 * Returns { render(records, seriesMeta[]) }.
 */
export function buildIndicatorCard(container, {
  chartId, title, sourceLabel, description,
  // Optional, from the catalog's chart def:
  //   refBand { from, to, label } — shaded horizontal band (the Bank of
  //                                 Canada's 1-3% inflation-control range)
  //   refLine { at, label }       — dashed horizontal rule (the 2% target)
  //   table   true                — render a collapsible data table under the
  //                                 chart, one row per period in the window
  refBand, refLine, table,
}) {
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card';
  card.dataset.chartId = chartId;
  // Card layout:
  //   title / subtitle / plot / latest-values / caption  ← captured in PNG
  //   actions row (Download)                             ← excluded from PNG
  //   stale-data banner                                  ← excluded from PNG
  //   "What does this mean?" explainer                   ← excluded from PNG
  // The stale banner is meta info for the appraiser, not part of the chart
  // they're embedding in a report — keep it visible on screen but out of the
  // exported image (see filter in exportCard).
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub" data-role="sub"></p>
    <div data-role="plot" style="min-height:240px"></div>
    <div data-role="empty" class="text-xs text-neutral-500 mt-2" hidden>No data for this filter combination.</div>
    <div data-role="latest" class="cmhc-latest-row"></div>
    <div class="chart-caption">
      <span class="chart-caption-left" data-role="caption-left"></span>
      <span class="chart-source" data-role="source"></span>
    </div>
    <div class="chart-actions">
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>
    <div data-role="stale" class="cmhc-stale-warning" hidden></div>
    ${table ? `
      <details class="cmhc-chart-table">
        <summary>Data table</summary>
        <div class="chart-actions">
          <button type="button" data-role="copy-table">Copy table</button>
        </div>
        <div class="cmhc-chart-table-scroll" data-role="table"></div>
        <p class="cmhc-chart-table-note" data-role="table-note"></p>
      </details>
    ` : ''}
    ${description ? `
      <details class="cmhc-explainer">
        <summary>What does this mean?</summary>
        <p data-role="explainer-body"></p>
      </details>
    ` : ''}
  `;
  if (description) {
    card.querySelector('[data-role="explainer-body"]').textContent = description;
  }
  container.appendChild(card);

  const $sub      = card.querySelector('[data-role="sub"]');
  const $stale    = card.querySelector('[data-role="stale"]');
  const $plot     = card.querySelector('[data-role="plot"]');
  const $empty    = card.querySelector('[data-role="empty"]');
  const $latest   = card.querySelector('[data-role="latest"]');
  const $capLeft  = card.querySelector('[data-role="caption-left"]');
  const $source   = card.querySelector('[data-role="source"]');
  const $png      = card.querySelector('[data-role="dl-png"]');
  const $table    = card.querySelector('[data-role="table"]');
  const $tableNote = card.querySelector('[data-role="table-note"]');
  const $copyTable = card.querySelector('[data-role="copy-table"]');
  const $tableBox = card.querySelector('.cmhc-chart-table');

  // Deferred table build. `render` only stashes what the table needs; the rows
  // are materialised when the user actually opens it (or copies it), and
  // rebuilt on the next open if the chart re-rendered in the meantime.
  let tableInput = null;
  let tableTsv = '';
  let tableFresh = false;

  function buildTableNow() {
    if (!$table || !tableInput) return;
    const { periods, seriesMeta, freq, yFormatter } = tableInput;
    tableTsv = renderDataTable($table, periods, seriesMeta, freq, yFormatter);
    $tableNote.textContent =
      `${periods.length} periods, ${periodLabel(periods[0].date, freq)}–` +
      `${periodLabel(periods[periods.length - 1].date, freq)}, newest first. ` +
      `Follows the tab's date range. “${MISSING}” = no observation.`;
    tableFresh = true;
  }

  if ($tableBox) {
    $tableBox.addEventListener('toggle', () => {
      if ($tableBox.open && !tableFresh) buildTableNow();
    });
  }
  if ($copyTable) {
    $copyTable.addEventListener('click', () => {
      if (!tableFresh) buildTableNow();
      copyTsv($copyTable, tableTsv);
    });
  }

  $source.textContent = `Source: ${sourceLabel || 'see series'}`;
  let lastFilename = `cmhc_${chartId}.png`;

  function render(records, seriesMeta, opts = {}) {
    $plot.replaceChildren();
    $stale.hidden = true;
    $stale.textContent = '';
    $latest.replaceChildren();
    $capLeft.textContent = '';
    if ($table) {
      $table.replaceChildren();
      $tableNote.textContent = '';
      tableInput = null;
      tableTsv = '';
      tableFresh = false;
    }

    const ids = new Set(seriesMeta.map(s => s.id));
    const rows = records.filter(r => ids.has(r.id));
    if (rows.length === 0) {
      $sub.textContent = opts.subtitle || '';
      $empty.hidden = false;
      $png.disabled = true;
      return;
    }
    $empty.hidden = true;
    $png.disabled = false;

    // Convert ISO strings to Date and look up the chartLabel for each row.
    const labelById = Object.fromEntries(seriesMeta.map(s => [s.id, s.chartLabel || s.id]));
    const points = rows.map(r => ({
      date:  new Date(r.date),
      value: r.value,
      label: labelById[r.id],
      id:    r.id,
    }));

    // Sort the colour domain by the chartLabel order in seriesMeta so the
    // legend reads in catalog order.
    const colorDomain = seriesMeta.map(s => s.chartLabel || s.id);

    const allValues = points.map(p => p.value).filter(Number.isFinite);
    const yFormatter = pickFormatter(seriesMeta[0]?.units || 'index', allValues);

    // Apply month-range filter from opts (passed as { monthFrom, monthTo },
    // each "YYYY-MM"). Record dates are parsed UTC (new Date("2026-06-23")), so
    // build the bounds in UTC too: from = first day of monthFrom, to = last
    // day of monthTo (end-of-day, to include that whole month).
    const monthBound = (m, end) => {
      if (!m) return null;
      const [y, mo] = String(m).split('-').map(Number);
      if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
      return end ? new Date(Date.UTC(y, mo, 0, 23, 59, 59))   // last day of mo
                 : new Date(Date.UTC(y, mo - 1, 1));          // first day of mo
    };
    const minDate = monthBound(opts.monthFrom, false);
    const maxDate = monthBound(opts.monthTo, true);
    const filtered = points.filter(p =>
      (!minDate || p.date >= minDate) && (!maxDate || p.date <= maxDate)
    );
    if (filtered.length === 0) {
      $sub.textContent = opts.subtitle || '';
      $empty.hidden = false;
      $png.disabled = true;
      return;
    }

    const vals = filtered.map(p => p.value);
    const balanceOfOpinion = seriesMeta.some(s => s.units === 'balance_of_opinion');
    const yDomain = yDomainFor(vals, { balanceOfOpinion, refBand, refLine });
    // Draw the zero rule whenever the axis can show negatives — always for a
    // balance of opinion, and for a rate series that actually dips below zero.
    const allowsNegative = balanceOfOpinion || yDomain[0] < 0;

    // Date extent of what's actually plotted, for the reference band's width.
    // (filtered is id-major, not date-sorted, so scan rather than take ends.)
    const xMin = filtered.reduce((a, p) => (p.date < a ? p.date : a), filtered[0].date);
    const xMax = filtered.reduce((a, p) => (p.date > a ? p.date : a), filtered[0].date);

    const freq = seriesMeta[0]?.frequency;
    const periods = buildTipRows(filtered, freq, yFormatter);

    const spec = themed({
      height: 260,
      x: {
        type: 'utc',
        label: null,
        tickFormat: (d) => {
          const yr = d.getUTCFullYear();
          return yr.toString();
        },
        inset: 8,
      },
      y: {
        label: null,
        tickFormat: yFormatter,
        domain: yDomain,
        nice: true,
        insetTop: 10,
      },
      color: { domain: colorDomain, range: PALETTE, legend: false, label: null },
      marks: [
        ...gridMarks(),
        ...(refBand ? [Plot.rect([refBand], {
          x1: xMin, x2: xMax, y1: 'from', y2: 'to',
          fill: REF_COLOUR, fillOpacity: 0.07,
        })] : []),
        ...(refLine ? [Plot.ruleY([refLine.at], {
          stroke: REF_COLOUR, strokeWidth: 1, strokeDasharray: '4 3',
        })] : []),
        ...(allowsNegative ? [Plot.ruleY([0], { stroke: '#52525b', strokeWidth: 0.8 })] : []),
        Plot.lineY(filtered, {
          x: 'date',
          y: 'value',
          stroke: 'label',
          strokeWidth: 1.6,
          defined: (d) => d.value != null,
        }),
        Plot.tip(periods, Plot.pointerX({
          x: 'date',
          y: 'anchor',
          title: 'text',
          fontSize: 11,
          lineHeight: 1.3,
        })),
        frameMark(),
      ],
    });
    const svgEl = Plot.plot(spec);

    // Custom vertical legend on the right.
    const legendEl = document.createElement('div');
    legendEl.className = 'cmhc-plot-legend';
    colorDomain.forEach((cat, i) => {
      const colour = PALETTE[i % PALETTE.length];
      const item = document.createElement('div');
      item.className = 'cmhc-plot-legend-item';
      item.innerHTML =
        `<span class="cmhc-plot-legend-swatch" style="background:${colour}"></span>` +
        `<span class="cmhc-plot-legend-text"></span>`;
      item.querySelector('.cmhc-plot-legend-text').textContent = cat;
      legendEl.appendChild(item);
    });
    // Annotation key for the reference band / line, so the shading is never
    // mistaken for a data series.
    if (refBand || refLine) {
      const note = document.createElement('div');
      note.className = 'cmhc-plot-legend-note';
      note.textContent = [refBand?.label, refLine?.label].filter(Boolean).join(' • ');
      legendEl.appendChild(note);
    }

    const wrap = document.createElement('div');
    wrap.className = 'cmhc-plot-wrap';
    wrap.appendChild(svgEl);
    wrap.appendChild(legendEl);
    $plot.appendChild(wrap);

    // Subtitle + caption + latest-value row.
    // Embed the year range in the subtitle (moved out of the caption row
    // per user request — the caption now only carries the source label).
    const minD = filtered[0].date, maxD = filtered[filtered.length - 1].date;
    const yearRange = `${minD.getUTCFullYear()}–${maxD.getUTCFullYear()}`;
    const baseSub = opts.subtitle || '';
    $sub.textContent = baseSub ? `${baseSub} • ${yearRange}` : yearRange;
    $capLeft.textContent = '';

    // Latest-value row: one chip per series.
    const today = new Date();
    let staleSeries = [];
    seriesMeta.forEach((s, i) => {
      const colour = PALETTE[i % PALETTE.length];
      if (!s.latestDate) return;
      const chip = document.createElement('span');
      chip.className = 'cmhc-latest-chip';
      chip.innerHTML =
        `<span class="cmhc-latest-swatch" style="background:${colour}"></span>` +
        `<span class="cmhc-latest-label"></span>: ` +
        `<strong></strong> <span class="cmhc-latest-asof"></span>`;
      chip.querySelector('.cmhc-latest-label').textContent = s.chartLabel || s.id;
      chip.querySelector('strong').textContent = yFormatter(s.latestValue);
      chip.querySelector('.cmhc-latest-asof').textContent = ` (as of ${s.latestDate})`;
      $latest.appendChild(chip);

      const ageDays = (today - new Date(s.latestDate)) / 86400000;
      const limit = FRESHNESS_OVERRIDE_DAYS[chartId] ?? (FRESHNESS_DAYS[s.frequency] || 365);
      if (ageDays > limit) staleSeries.push(`${s.chartLabel || s.id} (${Math.round(ageDays)}d old)`);
    });

    if (staleSeries.length) {
      $stale.hidden = false;
      $stale.textContent = `Stale data: ${staleSeries.join(', ')}.`;
    }

    // Data table — the readable counterpart to the hover tooltip, so a
    // specific period (say May 2023) can be looked up, copied, or quoted.
    // Built when opened rather than now; see buildTableNow above.
    if ($table) {
      tableInput = { periods, seriesMeta, freq, yFormatter };
      tableFresh = false;
      if ($tableBox?.open) buildTableNow();
    }

    lastFilename = `cmhc_${chartId}_${new Date().toISOString().slice(0,10)}.png`;
    $png.onclick = () => exportCard(card, lastFilename, 'png');
  }

  // Restore a set of open panels (see readOpenPanels). Panels not named are
  // closed, which is a no-op on a freshly built card.
  function setOpenPanels(keys) {
    const want = new Set(keys || []);
    for (const [key, selector] of Object.entries(PANEL_SELECTORS)) {
      const el = card.querySelector(selector);
      if (el) el.open = want.has(key);
    }
    if (want.has('table') && !tableFresh) buildTableNow();
  }

  return { card, render, setOpenPanels };
}

async function exportCard(card, filename, kind) {
  card.classList.add('cmhc-exporting');
  try {
    const opts = {
      backgroundColor: '#ffffff',
      pixelRatio: kind === 'png' ? 3 : 1,
      cacheBust: true,
      // Skip the cross-origin Google Fonts inline attempt (CORS SecurityError,
      // ~3s stall, system-font fallback regardless) — matches doc-image-export.js.
      skipFonts: true,
      // Drop the action row, stale-data banner, and explainer from the export
      // so the rendered image stays scoped to title → chart → latest values →
      // caption. These are on-screen helpers, not part of the chart someone
      // embeds in an appraisal report.
      filter: (n) => !(n.classList && (
        n.classList.contains('chart-actions') ||
        n.classList.contains('cmhc-stale-warning') ||
        n.classList.contains('cmhc-chart-table') ||
        n.classList.contains('cmhc-explainer'))),
    };
    const dataUrl = await toPng(card, opts);
    const blob = await (await fetch(dataUrl)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) { console.error('[indicator-chart export]', err); }
  finally { card.classList.remove('cmhc-exporting'); }
}
