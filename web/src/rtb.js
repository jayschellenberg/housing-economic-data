/*
 * RTB (MB) view — Manitoba Residential Tenancies Branch rent-control data:
 *   - the current annual rent-increase guideline (value, effective date,
 *     economic adjustment factor, the $/mo exemption threshold) + source links,
 *   - an appraisal-ready "Rent Controls" narrative with a Download Word button,
 *   - the year-by-year guideline history (1982–present) as a chart overlaid with
 *     the Manitoba All-Items CPI annual change it's derived from, plus a table.
 *
 * Data is pre-scraped monthly by r/19_scrape_rtb.R into
 * web/public/data/economy/rtb_mb.json.
 */

import * as Plot from '@observablehq/plot';
import { themed, gridMarks, frameMark, PALETTE } from './plot-theme.js';
import { downloadCard } from './chart.js';

const miss = (v) => v == null || !Number.isFinite(Number(v));
const fPct = (v) => miss(v) ? '**' : `${Number(v).toFixed(1)}%`;
const fUsd = (v) => miss(v) ? '**' : `$${Math.round(Number(v)).toLocaleString()}`;
const longDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};

// The appraisal "Rent Controls" narrative, as ordered blocks shared by the
// on-screen render and the Word export. Dynamic values come from `current`;
// the rest is standard report boilerplate. NB the CPI is "not seasonally
// adjusted" per the official RTB methodology (the source page + StatsCan).
function narrativeBlocks(c) {
  const yr  = c.year;
  const pct = fPct(c.guidelinePct);
  const eff = longDate(c.effectiveDate) || `January 1, ${yr}`;
  const eaf = miss(c.economicAdjustmentFactorPct) ? null : fPct(c.economicAdjustmentFactorPct);
  const thr = fUsd(c.exemptionThreshold);
  const blocks = [
    { type: 'title', text: 'Rent Controls' },
    { type: 'para', text: 'All properties in Manitoba are under the jurisdiction of The Residential Tenancies Act and the Residential Rent Regulation. New properties are exempt for 20 years from first occupancy.' },
    { type: 'para', text: `The ${yr} rent guideline has been set at ${pct}, effective ${eff}. The guideline is determined based on the percentage change in the average annual “All-Items”, not seasonally adjusted Consumer Price Index (Manitoba only) data published by Statistics Canada.${eaf ? ` The economic adjustment factor for ${yr} is ${eaf}. The economic adjustment factor helps to offset the costs of inflation.` : ''}` },
    { type: 'para', text: 'Tenants must be given proper written notice at least three months before a rent increase takes effect, and a notice to increase rent must meet the requirements of The Residential Tenancies Act. In most circumstances, rents can only be increased once a year.' },
    { type: 'para', text: 'The guideline applies to most rented residential apartments, single rooms, houses and duplexes. Some units are exempt from Part 9 of The Residential Tenancies Act and do not have to follow the annual rent increase guideline. These are:' },
    { type: 'bullet', text: `units renting for ${thr} or more per month` },
    { type: 'bullet', text: 'various types of social housing' },
    { type: 'bullet', text: 'rental units owned and operated by, or for, provincial, municipal, or federal governments' },
    { type: 'bullet', text: 'rental units in buildings first occupied after March 2005' },
    { type: 'bullet', text: 'not-for-profit life lease units' },
    { type: 'bullet', text: 'cooperative units' },
    { type: 'bullet', text: 'approved rehabilitated rental units' },
    { type: 'para', text: 'Landlords can apply for a larger increase if they can demonstrate that the guideline amount will not cover the cost increases they have incurred. Major rehabilitation work can result in exemptions from the guidelines for a period of up to five years.' },
    { type: 'para', text: 'Fee simple property rights are further prescribed by The Residential Tenancies Act; however, this legislation is moderate and not expected to significantly affect property value, as properties like the subject continue to be marketable.' },
    { type: 'para', text: 'More information can be found online at: http://www.gov.mb.ca/cca/rtb/' },
  ];
  return blocks;
}

export async function initRtb() {
  const $head  = document.getElementById('rtb-headline');
  const $narr  = document.getElementById('rtb-narrative');
  const $chart = document.getElementById('rtb-chart');
  const $table = document.getElementById('rtb-table');
  if (!$head || !$narr) return;

  const data = await fetch('./data/economy/rtb_mb.json')
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!data || !data.current) {
    $narr.innerHTML = '<p class="text-sm text-red-700">RTB data not found. Run r/19_scrape_rtb.R.</p>';
    return;
  }
  const c = data.current;
  const cpiByYear = new Map((data.cpi || []).map(x => [x.year, x.changePct]));

  // ---- Headline: the current guideline ------------------------------------
  const eff = longDate(c.effectiveDate) || `January 1, ${c.year}`;
  $head.innerHTML = `
    <div class="cmhc-hsk-title">Manitoba rent increase guideline <span>— ${c.year}</span></div>
    <div class="aff-stat-row">
      <div class="aff-stat aff-ok">
        <div class="aff-stat-label">${c.year} guideline</div>
        <div class="aff-stat-value">${fPct(c.guidelinePct)}</div>
        <div class="aff-stat-sub">effective ${escapeHtml(eff)}</div>
      </div>
      <div class="aff-stat">
        <div class="aff-stat-label">Economic adjustment factor</div>
        <div class="aff-stat-value">${fPct(c.economicAdjustmentFactorPct)}</div>
        <div class="aff-stat-sub">offsets inflation costs</div>
      </div>
      <div class="aff-stat">
        <div class="aff-stat-label">Guideline exemption</div>
        <div class="aff-stat-value">${fUsd(c.exemptionThreshold)}</div>
        <div class="aff-stat-sub">units at/above this rent are exempt</div>
      </div>
    </div>
    <p class="text-xs text-neutral-500 mt-1">The guideline is the maximum most landlords may raise rent in a year without applying for more; it is set from the percentage change in Manitoba’s average annual All-Items CPI (not seasonally adjusted). Tenants must get ≥3 months’ written notice and rents generally rise only once a year.</p>`;

  // ---- Narrative + download + links ---------------------------------------
  const blocks = narrativeBlocks(c);
  // Render the narrative, wrapping consecutive bullets in a single <ul>.
  let narrBody = '';
  let inList = false;
  blocks.forEach((b, i) => {
    if (b.type === 'bullet') {
      if (!inList) { narrBody += '<ul class="list-disc pl-6 mb-2 space-y-0.5">'; inList = true; }
      narrBody += `<li>${linkify(b.text)}</li>`;
    } else {
      if (inList) { narrBody += '</ul>'; inList = false; }
      if (b.type !== 'title') narrBody += `<p class="mb-2">${linkify(b.text)}</p>`;
    }
  });
  if (inList) narrBody += '</ul>';

  const links = [
    ['Current guideline (RTB)', data.guidelineUrl],
    ['How it’s calculated', data.calculateUrl],
    ['Historical guidelines (PDF)', data.historyUrl],
    ['Residential Tenancies Branch', data.sourceUrl],
    ['The Residential Tenancies Act', data.actUrl],
  ].filter(([, u]) => u);

  $narr.innerHTML = `
    <section class="cmhc-table-block">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="cmhc-table-title">Rent Controls — appraisal narrative (${c.year})</div>
        <button id="rtb-download-docx" type="button"
          class="text-sm bg-accent-500 hover:bg-accent-600 text-white rounded px-3 py-1.5">Download Word (annual document)</button>
      </div>
      <div class="text-sm text-neutral-800 leading-relaxed mt-2 max-w-3xl">${narrBody}</div>
      <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        ${links.map(([t, u]) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener" class="text-accent-600 hover:underline">${escapeHtml(t)} ↗</a>`).join('')}
      </div>
      <p class="text-xs text-neutral-500 mt-2">The narrative auto-fills the current guideline values; it’s standard report boilerplate — edit freely after download.</p>
    </section>`;

  document.getElementById('rtb-download-docx')?.addEventListener('click', async () => {
    const { exportNarrativeToWord } = await import('./word-export.js');
    // exportNarrativeToWord supports title/meta/heading/para/image — render
    // bullets as "•"-prefixed paragraphs so the list survives in Word.
    const wblocks = [];
    for (const b of blocks) {
      if (b.type === 'bullet') wblocks.push({ type: 'para', text: `•  ${b.text}` });
      else wblocks.push(b);
    }
    wblocks.splice(1, 0, { type: 'meta', text: `Manitoba Residential Tenancies Branch · guideline ${fPct(c.guidelinePct)} effective ${eff} · retrieved ${data.scrapedAt || ''}` });
    await exportNarrativeToWord(wblocks, { filename: `Manitoba_Rent_Controls_${c.year}.docx` });
  });

  // ---- History chart: guideline vs MB CPI ---------------------------------
  renderChart($chart, data, cpiByYear);

  // ---- History table ------------------------------------------------------
  renderTable($table, data, cpiByYear);
}

function renderChart($chart, data, cpiByYear) {
  if (!$chart) return;
  const hist = (data.history || []).slice().sort((a, b) => a.year - b.year);
  if (!hist.length) { $chart.replaceChildren(); return; }
  const rows = [];
  for (const h of hist) {
    rows.push({ year: h.year, series: 'Rent guideline', value: h.pct });
    const cpi = cpiByYear.get(h.year);
    if (cpi != null) rows.push({ year: h.year, series: 'MB All-Items CPI (annual change)', value: cpi });
  }
  const series = ['Rent guideline', 'MB All-Items CPI (annual change)'];
  const loY = hist[0].year, hiY = hist[hist.length - 1].year;
  const maxV = Math.max(...rows.map(d => d.value), 5);
  const minV = Math.min(0, ...rows.map(d => d.value));
  const svg = Plot.plot(themed({
    height: 300, marginBottom: 34, marginLeft: 40,
    x: { label: null, tickFormat: 'd' },
    y: { label: '% change', tickFormat: v => `${v}%`, domain: [minV, maxV * 1.1], grid: true },
    color: { domain: series, range: [PALETTE[0], '#dc2626'], legend: true },
    marks: [
      ...gridMarks(),
      Plot.ruleY([0], { stroke: '#9ca3af' }),
      Plot.lineY(rows, { x: 'year', y: 'value', stroke: 'series', strokeWidth: 1.8 }),
      Plot.dot(rows.filter(d => d.series === 'Rent guideline'), { x: 'year', y: 'value', fill: PALETTE[0], r: 2.5 }),
      frameMark(),
    ],
  }));
  const card = document.createElement('section');
  card.className = 'chart-card';
  card.innerHTML = `<header class="chart-title">Rent increase guideline vs Manitoba CPI</header>
    <p class="chart-sub">${loY}–${hiY} — annual rent-increase guideline and the Manitoba All-Items CPI change it is derived from</p>
    <div data-role="plot" class="cmhc-plot"></div>
    <div class="chart-caption"><span class="chart-caption-left"></span>
      <span class="chart-source">Source: Manitoba RTB; StatsCan (MB All-Items CPI)</span></div>
    <div class="chart-actions"><button type="button" data-role="dl-png">Download PNG</button></div>`;
  card.querySelector('[data-role="plot"]').appendChild(svg);
  card.querySelector('[data-role="dl-png"]').onclick = () =>
    downloadCard(card, `rtb-guideline-history-${new Date().toISOString().slice(0, 10)}.png`, 'png');
  $chart.replaceChildren(card);
}

function renderTable($table, data, cpiByYear) {
  if (!$table) return;
  const hist = data.history || [];
  const body = hist.map(h => {
    const cpi = cpiByYear.get(h.year);
    return `<tr><td>${h.year}</td><td>${fPct(h.pct)}</td><td>${fPct(h.eaf)}</td><td>${cpi == null ? '**' : fPct(cpi)}</td></tr>`;
  }).join('');
  $table.innerHTML = `
    <section class="cmhc-table-block">
      <div class="cmhc-table-title">Rent increase guidelines by year — Manitoba</div>
      <table class="cmhc-table"><thead><tr><th>Year</th><th>Guideline</th><th>Economic adjustment factor</th><th>MB All-Items CPI (annual change)</th></tr></thead>
        <tbody>${body}</tbody></table>
      <p class="text-xs text-neutral-500 mt-2">Guideline + <strong>economic adjustment factor</strong>: Manitoba Residential Tenancies Branch (the economic adjustment factor is a separate figure used for above-guideline applications; first published for 2024, so earlier years show “**”). CPI: Statistics Canada, Manitoba All-Items CPI (not seasonally adjusted), annual-average year-over-year change — the series the guideline is derived from (the guideline for a year reflects CPI measured the prior year). “**” = not published.</p>
    </section>`;
}

// Turn bare URLs in narrative text into links for the on-screen version.
function linkify(s) {
  return escapeHtml(s).replace(/(https?:\/\/[^\s]+)/g,
    u => `<a href="${u}" target="_blank" rel="noopener" class="text-accent-600 hover:underline">${u}</a>`);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
