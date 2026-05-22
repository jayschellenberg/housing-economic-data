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
import { toPng, toSvg } from 'html-to-image';
import { themed, PALETTE, gridMarks, frameMark } from './plot-theme.js';

// --- Formatters --------------------------------------------------------------
const FMT = {
  percent:           (v) => `${Number(v).toFixed(2)}%`,
  dollar:            (v) => `$${Math.round(Number(v)).toLocaleString()}`,
  dollar_millions:   (v) => `$${(Number(v) / 1e6).toFixed(1)}M`,
  index:             (v) => Number(v).toFixed(1),
  units:             (v) => Math.round(Number(v)).toLocaleString(),
  persons:           (v) => Math.round(Number(v)).toLocaleString(),
  // StatsCan's "Persons in thousands" series — cansim's val_norm has already
  // applied the ×1000 scalar, so the value is in raw persons. Render as
  // millions for readability (e.g. 21,034,500 → "21.0M").
  persons_thousands: (v) => `${(Number(v) / 1e6).toFixed(1)}M`,
  ratio:             (v) => Number(v).toFixed(2),
  balance_of_opinion:(v) => `${Number(v).toFixed(0)}`,
};
const fmt = (units) => FMT[units] || ((v) => String(v));

// Permits raw values are dollars and span 6-10 figures; render as $M.
function pickFormatter(units, values) {
  if (units === 'dollar') {
    const max = Math.max(...values.filter(Number.isFinite));
    if (max >= 1e6) return FMT.dollar_millions;
  }
  return fmt(units);
}

// Months between two ISO dates.
function monthsBetween(isoA, isoB) {
  const a = new Date(isoA), b = new Date(isoB);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

// Freshness thresholds in days, by frequency.
const FRESHNESS_DAYS = {
  daily:     14,
  weekly:    14,
  monthly:   90,
  quarterly: 200,
  irregular: 365,
};

/**
 * Build an indicator chart panel and append it to `container`.
 * Returns { render(records, seriesMeta[]) }.
 */
export function buildIndicatorCard(container, { chartId, title, sourceLabel, description }) {
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card';
  card.dataset.chartId = chartId;
  card.innerHTML = `
    <header class="chart-title">${title}</header>
    <p class="chart-sub" data-role="sub"></p>
    <div data-role="stale" class="cmhc-stale-warning" hidden></div>
    <div data-role="plot" style="min-height:240px"></div>
    <div data-role="empty" class="text-xs text-neutral-500 mt-2" hidden>No data for this filter combination.</div>
    <div data-role="latest" class="cmhc-latest-row"></div>
    <div class="chart-caption">
      <span class="chart-caption-left" data-role="caption-left"></span>
      <span class="chart-source" data-role="source"></span>
    </div>
    <div class="chart-actions">
      <button type="button" data-role="dl-svg">Download SVG</button>
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>
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
  const $svg      = card.querySelector('[data-role="dl-svg"]');
  const $png      = card.querySelector('[data-role="dl-png"]');

  $source.textContent = `Source: ${sourceLabel || 'see series'}`;
  let lastFilename = `cmhc_${chartId}.png`;

  function render(records, seriesMeta, opts = {}) {
    $plot.replaceChildren();
    $stale.hidden = true;
    $stale.textContent = '';
    $latest.replaceChildren();
    $capLeft.textContent = '';

    const ids = new Set(seriesMeta.map(s => s.id));
    const rows = records.filter(r => ids.has(r.id));
    if (rows.length === 0) {
      $sub.textContent = opts.subtitle || '';
      $empty.hidden = false;
      $svg.disabled = true; $png.disabled = true;
      return;
    }
    $empty.hidden = true;
    $svg.disabled = false; $png.disabled = false;

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

    // Apply year-range filter from opts (passed as { yearFrom, yearTo }).
    const minDate = opts.yearFrom ? new Date(opts.yearFrom, 0, 1) : null;
    const maxDate = opts.yearTo   ? new Date(opts.yearTo, 11, 31) : null;
    const filtered = points.filter(p =>
      (!minDate || p.date >= minDate) && (!maxDate || p.date <= maxDate)
    );
    if (filtered.length === 0) {
      $sub.textContent = opts.subtitle || '';
      $empty.hidden = false;
      $svg.disabled = true; $png.disabled = true;
      return;
    }

    const allowsNegative = seriesMeta.some(s => s.units === 'balance_of_opinion');
    const vals = filtered.map(p => p.value);
    const dataMin = Math.min(...vals);
    const dataMax = Math.max(...vals);
    const yDomain = allowsNegative
      ? [Math.min(0, dataMin), Math.max(0, dataMax)]
      : [Math.max(0, Math.min(...vals)), dataMax];
    // For non-balance series we still want the y-axis to start near 0
    // when values are positive and the data range is "tight"; otherwise
    // a 5% pad on each side keeps lines off the frame.
    const yPad = Math.max(0.05 * (dataMax - dataMin), 0.01);

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
        domain: allowsNegative ? yDomain : [Math.max(0, dataMin - yPad), dataMax + yPad],
        nice: true,
        insetTop: 10,
      },
      color: { domain: colorDomain, range: PALETTE, legend: false, label: null },
      marks: [
        ...gridMarks(),
        ...(allowsNegative ? [Plot.ruleY([0], { stroke: '#52525b', strokeWidth: 0.8 })] : []),
        Plot.lineY(filtered, {
          x: 'date',
          y: 'value',
          stroke: 'label',
          strokeWidth: 1.6,
          defined: (d) => d.value != null,
        }),
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

    const wrap = document.createElement('div');
    wrap.className = 'cmhc-plot-wrap';
    wrap.appendChild(svgEl);
    wrap.appendChild(legendEl);
    $plot.appendChild(wrap);

    // Subtitle + caption + latest-value row.
    $sub.textContent = opts.subtitle || '';
    const minD = filtered[0].date, maxD = filtered[filtered.length - 1].date;
    $capLeft.textContent = `${minD.getUTCFullYear()}–${maxD.getUTCFullYear()}`;

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
      const limit = FRESHNESS_DAYS[s.frequency] || 365;
      if (ageDays > limit) staleSeries.push(`${s.chartLabel || s.id} (${Math.round(ageDays)}d old)`);
    });

    if (staleSeries.length) {
      $stale.hidden = false;
      $stale.textContent = `Stale data: ${staleSeries.join(', ')}.`;
    }

    lastFilename = `cmhc_${chartId}_${new Date().toISOString().slice(0,10)}.png`;
    $svg.onclick = () => exportCard(card, lastFilename.replace(/\.png$/, '.svg'), 'svg');
    $png.onclick = () => exportCard(card, lastFilename, 'png');
  }

  return { card, render };
}

async function exportCard(card, filename, kind) {
  card.classList.add('cmhc-exporting');
  try {
    const opts = {
      backgroundColor: '#ffffff',
      pixelRatio: kind === 'png' ? 3 : 1,
      cacheBust: true,
      // Drop both the action row and the explainer details from the export
      // so the rendered image stays scoped to title → chart → caption.
      filter: (n) => !(n.classList && (n.classList.contains('chart-actions') || n.classList.contains('cmhc-explainer'))),
    };
    const dataUrl = kind === 'png' ? await toPng(card, opts) : await toSvg(card, opts);
    const blob = await (await fetch(dataUrl)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) { console.error('[indicator-chart export]', err); }
  finally { card.classList.remove('cmhc-exporting'); }
}
