/*
 * Court view — Manitoba Court of King's Bench pre-judgment and post-judgment
 * interest. ONE rate applies to both, set quarterly under s. 79(1) of The
 * Court of King's Bench Act, Part XIV.
 *
 *   - headline: the rate in force, the quarter it took effect, and the
 *     provenance of the official table being reproduced,
 *   - a step chart of the rate by quarter (a rate holds for its whole quarter,
 *     so a step is the honest shape — an interpolated line would imply the rate
 *     drifts between quarters, which it does not),
 *   - the full quarter-by-quarter table with copy-to-clipboard and Excel export,
 *   - an interest calculator that accrues simple interest quarter by quarter at
 *     each quarter's published rate.
 *
 * Data is pre-scraped monthly by r/25_scrape_court.R into
 * web/public/data/court/court_interest.json.
 */

import * as Plot from '@observablehq/plot';
import { themed, gridMarks, frameMark, PALETTE } from './plot-theme.js';
import { escapeHtml } from './escape.js';

const MISSING = '**';
const fRate = (v) => (Number.isFinite(v) ? `${Number(v).toFixed(2)}%` : MISSING);
const fPp = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)} pp` : MISSING);
const fMoney = (v) => (Number.isFinite(v)
  ? `$${v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : MISSING);
const fInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-CA') : MISSING);

const longDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
const DAY_MS = 86400000;
// Simple interest, actual days over a 365-day year. Stated on the tab so any
// other day-count convention can be checked against the per-quarter working.
const DAYS_IN_YEAR = 365;

/**
 * Turn the published rate rows into contiguous periods. A rate is in force
 * from its effective date until the next quarter's effective date; the newest
 * rate runs open-ended, so it is capped far in the future rather than left
 * unbounded.
 * @param {Array} rates rows of { effectiveDate, quarter, ratePct } in any order
 */
export function ratePeriods(rates) {
  const asc = [...(rates || [])]
    .filter(r => r && r.effectiveDate && Number.isFinite(Number(r.ratePct)))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return asc.map((r, i) => ({
    from: r.effectiveDate,
    to: i + 1 < asc.length ? asc[i + 1].effectiveDate : '9999-12-31',
    quarter: r.quarter,
    ratePct: Number(r.ratePct),
  }));
}

/**
 * Accrue simple interest on `principal` from `fromIso` up to (but not
 * including) `toIso`, stepping through each quarter at its own published rate.
 *
 * Returns the per-quarter working as well as the total, because the working is
 * what makes the number checkable — and flags the case where the requested
 * start predates the published table (the court publishes from 2014 only), so
 * the caller can say so rather than silently accruing from 2014.
 */
export function accrueInterest(principal, fromIso, toIso, rates) {
  const periods = ratePeriods(rates);
  const empty = { segments: [], totalInterest: 0, totalDays: 0, startsBeforePublished: false, publishedFrom: null };
  if (!periods.length || !fromIso || !toIso) return empty;
  const publishedFrom = periods[0].from;
  if (!(Number.isFinite(principal) && principal > 0) || fromIso >= toIso) {
    return { ...empty, publishedFrom };
  }

  const startsBeforePublished = fromIso < publishedFrom;
  const start = startsBeforePublished ? publishedFrom : fromIso;
  const segments = [];
  for (const p of periods) {
    const segFrom = start > p.from ? start : p.from;
    const segTo = toIso < p.to ? toIso : p.to;
    if (segFrom >= segTo) continue;
    const days = Math.round((utc(segTo) - utc(segFrom)) / DAY_MS);
    if (days <= 0) continue;
    const interest = principal * (p.ratePct / 100) * (days / DAYS_IN_YEAR);
    segments.push({ from: segFrom, to: segTo, days, quarter: p.quarter, ratePct: p.ratePct, interest });
  }
  return {
    segments,
    totalInterest: segments.reduce((sum, s) => sum + s.interest, 0),
    totalDays: segments.reduce((sum, s) => sum + s.days, 0),
    startsBeforePublished,
    publishedFrom,
  };
}

export async function initCourt() {
  const $head = document.getElementById('court-headline');
  const $chart = document.getElementById('court-chart');
  const $calc = document.getElementById('court-calc');
  const $table = document.getElementById('court-table');
  if (!$head || !$table) return;

  const data = await fetch('./data/court/court_interest.json')
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!data || !Array.isArray(data.rates) || !data.rates.length) {
    $head.innerHTML = '<p class="text-sm text-red-700">Court interest data not found. Run r/25_scrape_court.R.</p>';
    return;
  }
  // The scrape writes newest-first; keep that for display and derive ascending
  // where the maths needs it.
  const rows = [...data.rates].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));

  renderHeadline($head, data, rows);
  renderChart($chart, data, rows);
  renderCalculator($calc, data, rows);
  renderTable($table, data, rows);
}

// --- Headline ---------------------------------------------------------------
function renderHeadline($head, data, rows) {
  const cur = rows[0];
  const prev = rows[1];
  const delta = prev ? cur.ratePct - prev.ratePct : null;
  const since = firstQuarterAtCurrentRate(rows);
  const provenance = [
    data.dated ? `official table dated ${data.dated}` : null,
    data.signedBy ? `${data.signedBy}, ${data.signedRole || 'Registrar'}` : null,
    data.pageUpdated ? `page updated ${data.pageUpdated}` : null,
  ].filter(Boolean).join(' • ');

  $head.innerHTML = `
    <div class="cmhc-hsk-title">Pre-judgment &amp; post-judgment interest <span>— Manitoba</span></div>
    <div class="aff-stat-row">
      <div class="aff-stat aff-ok">
        <div class="aff-stat-label">Rate in force</div>
        <div class="aff-stat-value">${fRate(cur.ratePct)}</div>
        <div class="aff-stat-sub">effective ${escapeHtml(longDate(cur.effectiveDate) || cur.effectiveDate)}</div>
      </div>
      <div class="aff-stat">
        <div class="aff-stat-label">Change vs prior quarter</div>
        <div class="aff-stat-value">${delta === null ? MISSING : fPp(delta)}</div>
        <div class="aff-stat-sub">${prev ? `was ${escapeHtml(fRate(prev.ratePct))} in ${escapeHtml(prev.quarter)}` : 'no prior quarter published'}</div>
      </div>
      <div class="aff-stat">
        <div class="aff-stat-label">Unchanged since</div>
        <div class="aff-stat-value">${escapeHtml(since.quarter)}</div>
        <div class="aff-stat-sub">${since.count} consecutive quarter${since.count === 1 ? '' : 's'} at this rate</div>
      </div>
      <div class="aff-stat">
        <div class="aff-stat-label">Published history</div>
        <div class="aff-stat-value">${rows.length}</div>
        <div class="aff-stat-sub">quarters, from ${escapeHtml(rows[rows.length - 1].quarter)}</div>
      </div>
    </div>
    <p class="text-xs text-neutral-500 mt-1">One rate applies to <strong>both</strong> pre-judgment and post-judgment
      interest, set each quarter under ${escapeHtml(data.actCitation || "The Court of King's Bench Act, Part XIV, s. 79(1)")}.
      This is an unofficial reproduction of the court's published table for reference — not legal advice, and not a
      substitute for the official page.${provenance ? ` Source ${escapeHtml(provenance)}.` : ''}</p>`;
}

// How long the current rate has held, counted back through equal quarters.
function firstQuarterAtCurrentRate(rows) {
  const rate = rows[0].ratePct;
  let i = 0;
  while (i + 1 < rows.length && rows[i + 1].ratePct === rate) i += 1;
  return { quarter: rows[i].quarter, count: i + 1 };
}

// --- Chart ------------------------------------------------------------------
function renderChart($chart, data, rows) {
  if (!$chart) return;
  const asc = [...rows].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const points = asc.map(r => ({ date: utc(r.effectiveDate), quarter: r.quarter, ratePct: r.ratePct }));
  // Carry the newest rate to the end of its own quarter so the final step has
  // width; without it the last rate renders as a single point.
  const last = points[points.length - 1];
  const tail = { ...last, date: new Date(Date.UTC(last.date.getUTCFullYear(), last.date.getUTCMonth() + 3, 1)) };
  const line = [...points, tail];

  const maxV = Math.max(...points.map(p => p.ratePct));
  const svg = Plot.plot(themed({
    height: 280,
    marginBottom: 34,
    marginLeft: 44,
    x: { type: 'utc', label: null, tickFormat: (d) => d.getUTCFullYear().toString(), inset: 8 },
    y: { label: 'Interest rate', tickFormat: (v) => `${v}%`, domain: [0, maxV * 1.15], grid: true },
    marks: [
      ...gridMarks(),
      Plot.lineY(line, { x: 'date', y: 'ratePct', stroke: PALETTE[0], strokeWidth: 1.8, curve: 'step-after' }),
      Plot.dot(points, { x: 'date', y: 'ratePct', fill: PALETTE[0], r: 2.2 }),
      Plot.tip(points, Plot.pointerX({
        x: 'date',
        y: 'ratePct',
        title: (d) => `${d.quarter}\nEffective ${longDate(d.date.toISOString().slice(0, 10))}\nRate: ${fRate(d.ratePct)}`,
        fontSize: 11,
        lineHeight: 1.3,
      })),
      frameMark(),
    ],
  }));

  const card = document.createElement('section');
  card.className = 'chart-card';
  card.innerHTML = `
    <header class="chart-title">Pre-judgment &amp; post-judgment interest rate by quarter</header>
    <p class="chart-sub">${escapeHtml(rows[rows.length - 1].quarter)}–${escapeHtml(rows[0].quarter)} — the rate set under
      ${escapeHtml(data.actCitation || "s. 79(1)")}. Drawn as a step: each rate holds for its whole quarter. Hover for the rate at a quarter.</p>
    <div data-role="plot" class="cmhc-plot"></div>
    <div class="chart-caption"><span class="chart-caption-left"></span>
      <span class="chart-source">Source: Court of King's Bench of Manitoba</span></div>`;
  card.querySelector('[data-role="plot"]').appendChild(svg);
  $chart.replaceChildren(card);
}

// --- Interest calculator ----------------------------------------------------
function renderCalculator($calc, data, rows) {
  if (!$calc) return;
  const asc = [...rows].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const minDate = asc[0].effectiveDate;
  const todayIso = new Date().toISOString().slice(0, 10);
  const defaultFrom = (() => {
    const d = new Date(`${todayIso}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 2);
    return d.toISOString().slice(0, 10) < minDate ? minDate : d.toISOString().slice(0, 10);
  })();

  const card = document.createElement('section');
  card.className = 'chart-card cmhc-time-adjust';
  card.innerHTML = `
    <header class="chart-title">Interest calculator</header>
    <p class="chart-sub">Simple interest accrued quarter by quarter, each quarter at its own published rate.</p>
    <div class="cmhc-time-adjust-disclaimer">
      <strong>Disclaimer:</strong> arithmetic on the court's published rates, nothing more. Which rate applies, from
      what date, on what amount, and whether interest runs at all are legal determinations under
      ${escapeHtml(data.actCitation || "The Court of King's Bench Act")} and the order in question — not something this
      page decides. Check the figure against the per-quarter working below before relying on it.
    </div>
    <div class="cmhc-time-adjust-form">
      <label>Principal<input type="number" data-role="ci-principal" min="0" step="1000" value="100000" /></label>
      <label>From<input type="date" data-role="ci-from" min="${minDate}" value="${defaultFrom}" /></label>
      <label>To<input type="date" data-role="ci-to" min="${minDate}" value="${todayIso}" /></label>
      <button type="button" data-role="ci-go">Calculate</button>
    </div>
    <div data-role="ci-result" class="cmhc-time-adjust-result" hidden></div>`;
  $calc.replaceChildren(card);

  const $principal = card.querySelector('[data-role="ci-principal"]');
  const $from = card.querySelector('[data-role="ci-from"]');
  const $to = card.querySelector('[data-role="ci-to"]');
  const $out = card.querySelector('[data-role="ci-result"]');

  card.querySelector('[data-role="ci-go"]').addEventListener('click', () => {
    $out.hidden = false;
    const principal = parseFloat($principal.value);
    const fromIso = $from.value;
    const toIso = $to.value;
    if (!Number.isFinite(principal) || principal <= 0) {
      $out.innerHTML = '<p class="cmhc-time-adjust-error">Enter a principal amount greater than zero.</p>';
      return;
    }
    if (!fromIso || !toIso || fromIso >= toIso) {
      $out.innerHTML = '<p class="cmhc-time-adjust-error">The “to” date must be after the “from” date.</p>';
      return;
    }
    const res = accrueInterest(principal, fromIso, toIso, rows);
    if (!res.segments.length) {
      $out.innerHTML = '<p class="cmhc-time-adjust-error">That period falls outside the published rate table.</p>';
      return;
    }
    const body = res.segments.map(s => `
      <tr><td>${escapeHtml(s.quarter)}</td><td>${escapeHtml(longDate(s.from))}</td><td>${escapeHtml(longDate(s.to))}</td>
        <td>${s.days}</td><td>${fRate(s.ratePct)}</td><td>${fMoney(s.interest)}</td></tr>`).join('');
    const warn = res.startsBeforePublished
      ? `<p class="cmhc-time-adjust-detail">The court publishes rates from ${escapeHtml(longDate(res.publishedFrom))} only, so accrual starts there rather than at your “from” date. Anything earlier needs the rate from the court directly.</p>`
      : '';
    $out.innerHTML = `
      <p>Interest accrued: <strong>${fMoney(res.totalInterest)}</strong>
        <span class="cmhc-time-adjust-pct">on ${fMoney(principal)} over ${fInt(res.totalDays)} days</span></p>
      <p>Principal plus interest: <strong>${fMoney(principal + res.totalInterest)}</strong></p>
      ${warn}
      <div class="cmhc-chart-table-scroll" style="margin-top:8px">
        <table class="cmhc-table">
          <thead><tr><th>Quarter</th><th>From</th><th>To</th><th>Days</th><th>Rate</th><th>Interest</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="cmhc-time-adjust-detail">Simple (non-compounding) interest, actual days ÷ ${DAYS_IN_YEAR}, at each quarter's
        published rate. The last day is excluded. Rates: Court of King's Bench of Manitoba.</p>`;
  });
}

// --- Table ------------------------------------------------------------------
function renderTable($table, data, rows) {
  if (!$table) return;
  // Newest first, with the move from the quarter before it.
  const built = rows.map((r, i) => {
    const prev = rows[i + 1];
    return {
      quarter: r.quarter,
      effective: longDate(r.effectiveDate) || r.effectiveDate,
      rate: fRate(r.ratePct),
      change: prev ? fPp(r.ratePct - prev.ratePct) : MISSING,
    };
  });
  const body = built.map(b =>
    `<tr><td>${escapeHtml(b.quarter)}</td><td>${escapeHtml(b.effective)}</td><td>${escapeHtml(b.rate)}</td>` +
    `<td${b.change === MISSING ? ' class="cmhc-table-na"' : ''}>${escapeHtml(b.change)}</td></tr>`).join('');

  $table.innerHTML = `
    <section class="cmhc-table-block">
      <div class="cmhc-table-title">Pre-judgment and post-judgment interest rates by quarter — Manitoba</div>
      <table class="cmhc-table">
        <thead><tr><th>Quarter</th><th>Effective</th><th>Rate</th><th>Change</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p class="text-xs text-neutral-500 mt-2">Source: <a class="underline" href="${escapeHtml(data.sourceUrl)}" target="_blank" rel="noopener">Court of King's Bench of Manitoba — Pre-Judgment and Post-Judgment Interest</a>${data.pageUpdated ? ` (page updated ${escapeHtml(data.pageUpdated)})` : ''}. One rate applies to both pre-judgment and post-judgment interest, set quarterly under ${escapeHtml(data.actCitation || '')}. “Change” is the movement from the previous quarter in percentage points; “${MISSING}” = no earlier quarter published. Unofficial reproduction for reference, not legal advice.</p>
      <div class="chart-actions">
        <button type="button" data-role="court-copy">Copy table</button>
        <button type="button" data-role="court-xlsx">Download Excel</button>
      </div>
    </section>`;

  const exportShape = [{
    title: 'Pre-judgment and post-judgment interest rates by quarter — Manitoba',
    columns: ['Effective', 'Rate', 'Change'],
    rows: built.map(b => ({ area: b.quarter, values: [b.effective, b.rate, b.change === MISSING ? null : b.change] })),
  }];
  const titleNote = `— Court of King's Bench of Manitoba${data.pageUpdated ? `, ${data.pageUpdated}` : ''}`;

  const $copy = $table.querySelector('[data-role="court-copy"]');
  $copy.addEventListener('click', async () => {
    const original = $copy.textContent;
    const { copyTablesToClipboard } = await import('./clipboard-export.js');
    const result = await copyTablesToClipboard(exportShape, { titleNote });
    $copy.textContent = result === 'failed' ? 'Copy failed' : 'Copied';
    setTimeout(() => { $copy.textContent = original; }, 1600);
  });

  $table.querySelector('[data-role="court-xlsx"]').addEventListener('click', async () => {
    const { exportTablesToExcel } = await import('./excel-export.js');
    await exportTablesToExcel(exportShape, {
      filename: `mb-court-interest-${new Date().toISOString().slice(0, 10)}.xlsx`,
      sheetName: 'Court interest',
      titleNote,
    });
  });
}
