/*
 * Per-panel chart renderer. One call per chart card; the card is a div
 * with title + subtitle + plot + caption + actions, replaced on each
 * filter change.
 *
 * Drawing uses Observable Plot. Snapshot-stitched series (zone /
 * neighbourhood) may have year gaps; we break the line whenever the gap
 * to the prior point exceeds 1 year by setting `defined` on the line.
 *
 * The card styling matches the firm's appraisal chart template — bold
 * dark-red title, dashed light grid, framed plot, caption row with
 * "Source: CMHC" right-aligned.
 */

import * as Plot from '@observablehq/plot';
import { toPng } from 'html-to-image';
import { themed, fmt, PALETTE, gridMarks, frameMark } from './plot-theme.js';
import { escapeHtml } from './escape.js';

const COUNT_FMT = (v) => Number(v).toLocaleString();

const Y_FMT = {
  'Vacancy Rate':                    fmt.percent,
  'Average Rent':                    fmt.dollar,
  'Median Rent':                     fmt.dollar,
  'Average Rent Change':             fmt.pctChange,
  'Rental Universe':                 COUNT_FMT,
  // Starts & Completions (Scss)
  'Absorbed Units':                  COUNT_FMT,
  'Unabsorbed Inventory':            COUNT_FMT,
  // Secondary Rental Market (Srms)
  'Condo Vacancy Rate':              fmt.percent,
  'Condo Average Rent':              fmt.dollar,
  'Condo Universe':                  COUNT_FMT,
  'Rental Condo Universe':           COUNT_FMT,
  'Percentage Condo used as Rental': fmt.percent,
};

const Y_LABEL = {
  'Vacancy Rate':                    'Vacancy Rate (%)',
  'Average Rent':                    'Average Rent ($)',
  'Median Rent':                     'Median Rent ($)',
  'Average Rent Change':             'Avg Rent Change (%)',
  'Rental Universe':                 'Universe (Units)',
  'Absorbed Units':                  'Units',
  'Unabsorbed Inventory':            'Units',
  'Condo Vacancy Rate':              'Vacancy Rate (%)',
  'Condo Average Rent':              'Average Rent ($)',
  'Condo Universe':                  'Units',
  'Rental Condo Universe':           'Units',
  'Percentage Condo used as Rental': '% of Universe',
};

/**
 * Build a chart card and append it to `container`.
 * Returns a `render(rows, sub)` function the caller invokes with the
 * filtered record array and a subtitle string.
 */
export function buildChartCard(container, { series }) {
  const card = document.createElement('section');
  card.className = 'chart-card';
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(series)}</header>
    <p class="chart-sub" data-role="sub"></p>
    <div data-role="plot"></div>
    <div data-role="empty" class="text-xs text-neutral-500 mt-2" hidden>No data for this filter combination.</div>
    <div class="chart-caption">
      <span class="chart-caption-left" data-role="caption-left"></span>
      <span class="chart-source">Source: CMHC</span>
    </div>
    <div class="chart-actions">
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>
  `;
  container.appendChild(card);

  const $sub      = card.querySelector('[data-role="sub"]');
  const $plot     = card.querySelector('[data-role="plot"]');
  const $empty    = card.querySelector('[data-role="empty"]');
  const $capLeft  = card.querySelector('[data-role="caption-left"]');
  const $png      = card.querySelector('[data-role="dl-png"]');

  let lastFilename = `cmhc_${series.replace(/\s+/g, '_').toLowerCase()}.png`;

  function render(rows, sub, categoryOrder = [], meta = {}) {
    $plot.replaceChildren();
    // Left caption slot. The season/year range lives in the subtitle; this
    // slot is opt-in via meta.captionLeft (the Housing Starts tab uses it to
    // show the aggregate-line Median/Average). Cleared otherwise so the
    // caption row keeps "Source: CMHC" alone on the right.
    $capLeft.textContent = meta.captionLeft || '';

    if (!rows || rows.length === 0) {
      $sub.textContent = sub || '';
      $empty.hidden = false;
      $png.disabled = true;
      return;
    }
    $empty.hidden = true;
    $png.disabled = false;

    // Append the season + year-range to the subtitle. Built here (not in
    // main.js) because the year range comes from the filtered rows.
    const summary = summariseCaption(rows, meta);
    $sub.textContent = summary ? `${sub || ''} — ${summary}` : (sub || '');

    // Sort the colour domain by the canonical category order if provided.
    // categoryOrder is passed per-render so it tracks the active breakdown.
    const present = Array.from(new Set(rows.map(r => r.category)));
    const colorDomain = categoryOrder.length
      ? categoryOrder.filter(c => present.includes(c))
          .concat(present.filter(c => !categoryOrder.includes(c)))
      : present.sort();

    // Sort within each category by year so the line draws in order, and
    // tag each row with the gap to the prior point in the same category
    // so we can break the line where snapshot data has missing years.
    const byCat = new Map();
    rows.forEach(r => {
      if (!byCat.has(r.category)) byCat.set(r.category, []);
      byCat.get(r.category).push({ ...r });
    });
    const lineData = [];
    byCat.forEach((arr) => {
      arr.sort((a, b) => a.year - b.year);
      arr.forEach((r, i) => {
        const gap = i > 0 ? (r.year - arr[i - 1].year) : 0;
        lineData.push({ ...r, _gap: gap });
      });
    });

    const yFormatter = Y_FMT[series] || ((v) => String(v));
    // Force the y-axis to start at 0 on every panel EXCEPT % change, which
    // can be negative. `nice: true` (set in themed()) rounds the bounds.
    const vals = rows.map(r => Number(r.value)).filter(Number.isFinite);
    const dataMin = vals.length ? Math.min(...vals) : 0;
    const dataMax = vals.length ? Math.max(...vals) : 0;
    const allowsNegative = series === 'Average Rent Change';
    const yDomain = allowsNegative
      ? [Math.min(0, dataMin), Math.max(0, dataMax)]
      : [0, Math.max(0, dataMax)];

    // Build a year-tick set so both endpoints (e.g., 2015 AND 2025) render.
    // Plot's default picks "nice" interior ticks and drops the endpoints
    // when the domain is tight.
    const yearsPresent = [...new Set(rows.map(r => r.year).filter(Number.isFinite))].sort((a, b) => a - b);
    const yMinYr = yearsPresent[0];
    const yMaxYr = yearsPresent[yearsPresent.length - 1];
    const yrSpan = yMaxYr - yMinYr;
    const step   = yrSpan <= 12 ? 1 : yrSpan <= 24 ? 2 : yrSpan <= 50 ? 5 : 10;
    const tickYears = [];
    for (let y = yMinYr; y <= yMaxYr; y += step) tickYears.push(y);
    if (tickYears[tickYears.length - 1] !== yMaxYr) tickYears.push(yMaxYr);

    const spec = themed({
      height: 280,
      x: {
        // Half-year padding on each side so the first/last tick labels
        // sit inside the frame instead of being clipped at the edge.
        domain: [yMinYr - 0.5, yMaxYr + 0.5],
        ticks:  tickYears,
        tickFormat: 'd',
      },
      y: {
        label: Y_LABEL[series] || null,
        tickFormat: yFormatter,
        domain: yDomain,
      },
      // Plot's built-in legend is disabled; we render a custom right-side
      // vertical legend below so it sits beside the chart area.
      color: { domain: colorDomain, range: PALETTE, legend: false, label: null },
      marks: [
        ...gridMarks(),
        ...(allowsNegative ? [Plot.ruleY([0], { stroke: '#52525b', strokeWidth: 0.8 })] : []),
        Plot.lineY(lineData, {
          x: 'year',
          y: 'value',
          stroke: 'category',
          strokeWidth: 1.7,
          defined: (d) => d.value != null && d._gap <= 1,
        }),
        Plot.dot(rows, {
          x: 'year',
          y: 'value',
          fill: 'category',
          stroke: 'category',
          r: 2.6,
          title: (d) => `${d.category}\n${d.year}: ${yFormatter(d.value)}`,
        }),
        frameMark(),
      ],
    });

    const svgEl = Plot.plot(spec);

    // Custom legend to the right of the chart (see plotWrapWithLegend).
    $plot.appendChild(plotWrapWithLegend(svgEl, colorDomain));

    lastFilename = buildFilename(series, sub);
    // Export the entire card (title + subtitle + chart + legend + caption),
    // not just the chart SVG. We toggle a CSS marker class on the card so
    // the actions row (Download buttons) is hidden during capture.
    $png.onclick = () => downloadCard(card, lastFilename, 'png');
  }

  return { render, card };
}

// Build the chart + right-side vertical legend wrapper (shared by the line
// cards and the bar cards). Plot's built-in legend renders horizontally above
// the SVG; our own sits beside the plot and matches the appraisal template.
function plotWrapWithLegend(svgEl, colorDomain) {
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
  const wrap = document.createElement('div');
  wrap.className = 'cmhc-plot-wrap';
  wrap.appendChild(svgEl);
  wrap.appendChild(legendEl);
  return wrap;
}

/**
 * Build a grouped-bar chart card (same chrome as buildChartCard — title,
 * subtitle, plot + right-side area legend, "Source: CMHC" caption, Download
 * PNG). Used by the Rental Tables tab: each breakdown category is a facet, with
 * one bar per area. Returns a `render({ data, categories, areas, seriesType,
 * sub })` function; `data` is rows of `{ area, cat, value }`.
 */
export function buildBarCard(container, { title }) {
  const card = document.createElement('section');
  card.className = 'chart-card';
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub" data-role="sub"></p>
    <div data-role="plot"></div>
    <div data-role="empty" class="text-xs text-neutral-500 mt-2" hidden>No data for this combination.</div>
    <div class="chart-caption">
      <span class="chart-caption-left" data-role="caption-left"></span>
      <span class="chart-source">Source: CMHC</span>
    </div>
    <div class="chart-actions">
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>
  `;
  container.appendChild(card);
  const $sub   = card.querySelector('[data-role="sub"]');
  const $plot  = card.querySelector('[data-role="plot"]');
  const $empty = card.querySelector('[data-role="empty"]');
  const $png   = card.querySelector('[data-role="dl-png"]');

  function render({ data, categories, areas, seriesType, sub }) {
    $plot.replaceChildren();
    $sub.textContent = sub || '';
    if (!data || data.length === 0) { $empty.hidden = false; $png.disabled = true; return; }
    $empty.hidden = true; $png.disabled = false;

    const isVac = seriesType === 'vacancy';
    const yFmt = isVac ? (v) => `${v}%` : (v) => `$${Number(v).toLocaleString()}`;
    const maxV = Math.max(...data.map(d => d.value));
    const svgEl = Plot.plot(themed({
      height: 280, marginTop: 24, marginBottom: 22, marginLeft: 54,
      fx: { label: null, domain: categories },
      x: { axis: null, label: null, domain: areas },
      y: { label: isVac ? 'Vacancy Rate (%)' : 'Median Rent ($)', tickFormat: yFmt, domain: [0, maxV * 1.12] },
      color: { domain: areas, range: PALETTE, legend: false, label: null },
      marks: [
        ...gridMarks(),
        Plot.barY(data, { fx: 'cat', x: 'area', y: 'value', fill: 'area',
          title: (d) => `${d.area} · ${d.cat}: ${yFmt(d.value)}` }),
        frameMark(),
      ],
    }));
    $plot.appendChild(plotWrapWithLegend(svgEl, areas));
    $png.onclick = () => downloadCard(card, buildFilename(title, sub), 'png');
  }

  return { render, card };
}

function summariseCaption(rows, meta = {}) {
  if (!rows || rows.length === 0) return '';
  // Floor in case the caller is using fractional x values for sub-annual
  // periods (e.g. 2025.75 means Q4 2025 in the Housing Starts view).
  const years = rows.map(r => Math.floor(r.year)).filter(Number.isFinite);
  const yMin = Math.min(...years), yMax = Math.max(...years);
  const seasonPart = meta.season ? `${meta.season} ` : '';
  return `${seasonPart}${yMin}–${yMax}`;
}

function buildFilename(series, sub) {
  const today = new Date().toISOString().slice(0, 10);
  const safe = (s) => (s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `cmhc_${safe(sub)}_${safe(series)}_${today}.png`;
}

/**
 * Capture the entire chart card (title, subtitle, chart, legend, caption)
 * as an SVG or PNG via html-to-image. The actions row holding the Download
 * buttons is hidden through a CSS class while the snapshot is taken so it
 * doesn't appear in the output.
 *
 * PNG is rasterised at 3x device pixel ratio for crisp print resolution
 * (suitable for pasting into Word at standard column widths).
 */
export async function downloadCard(card, filename, kind) {
  card.classList.add('cmhc-exporting');
  try {
    const opts = {
      backgroundColor: '#ffffff',
      pixelRatio: kind === 'png' ? 3 : 1,
      cacheBust: true,
      // skipFonts: the only webfont is Inter via the cross-origin Google Fonts
      // stylesheet, whose cssRules can't be read (CORS) — html-to-image logs a
      // SecurityError and falls back to system fonts anyway. Skipping the
      // attempt removes the console noise and the ~3s per-capture stall, with
      // no change to the rasterised output (matches doc-image-export.js).
      skipFonts: true,
      // Filter: drop the actions row entirely from the captured DOM.
      filter: (node) => !(node.classList && node.classList.contains('chart-actions')),
    };
    const dataUrl = await toPng(card, opts);
    const blob = await (await fetch(dataUrl)).blob();
    triggerDownload(blob, filename);
  } catch (err) {
    console.error('[chart export]', err);
  } finally {
    card.classList.remove('cmhc-exporting');
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
