/*
 * MB Economic Update — an auto-filled narrative report mirroring the firm's
 * monthly "Province of Manitoba Overview and Economic Outlook" Word document.
 *
 * Prose templates live HERE (pure `(metric) => string` functions) so the
 * wording is editable in one place; the numbers + the editorial Outlook text
 * come from web/public/data/economy/economic-update.json (built by
 * r/15_build_economic_update.R from StatsCan/CMHC + scraped MLS/CREA + the
 * manual config). Two supporting charts (employment, HPI benchmark) are
 * mounted via the Market Indicators chart card. Copy + Word export let the
 * appraiser drop the report straight into their document.
 *
 * Graceful degradation: any metric flagged `stale` still renders, with an
 * inline "not updated" note, so the report never has a hole.
 */

import { buildIndicatorCard } from './indicator-chart.js';
import { captureNodes } from './doc-image-export.js';
import { escapeHtml } from './escape.js';

// --- Formatters --------------------------------------------------------------
const fmt0 = (v) => (v == null || isNaN(v)) ? '—' : Math.round(Number(v)).toLocaleString();
const pct1 = (v) => (v == null || isNaN(v)) ? '—' : `${Number(v).toFixed(1)}%`;
const pct0 = (v) => (v == null || isNaN(v)) ? '—' : `${Math.round(Math.abs(Number(v)))}%`;
const dollars = (v) => (v == null || isNaN(v)) ? '—' : `$${Math.round(Number(v)).toLocaleString()}`;
const wage = (v) => (v == null || isNaN(v)) ? '—' : `$${Number(v).toFixed(2)}`;   // keep cents

// "increased by 1.2%" / "decreased by 0.7%" / "was essentially unchanged"
function moveBy(changePct, direction) {
  const d = direction || (changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat');
  if (d === 'flat' || changePct == null || Math.abs(changePct) < 0.05) return 'was essentially unchanged';
  const word = d === 'up' ? 'increased' : 'decreased';
  return `${word} by ${Math.abs(changePct).toFixed(1)}%`;
}
// "up 4%" / "down 3%" — for the MLS year-over-year / 5-yr comparisons
function upDown(pct) {
  if (pct == null || isNaN(pct)) return '—';
  if (Math.abs(pct) < 0.5) return 'about even';
  return `${pct > 0 ? 'up' : 'down'} ${pct0(pct)}`;
}

function pushLine(arr, line) { if (line) arr.push(line); }

// Does this metric carry a usable number, or is it an empty/embargoed shell?
function hasData(m) {
  return m && (m.changePct != null || m.value != null || m.ytdChangePct != null
    || m.totalChangePct != null || m.growthPct != null || m.changePP != null);
}
// Render a metric's sentence, or a clean "not available" line if it has no data.
function indLine(metric, tmplFn, label) {
  if (!metric) return null;
  if (!hasData(metric)) {
    return `<span style="color:#6b7280">${escapeHtml(label)} figures were not available for the latest release `
      + `(the source table is embargoed or pending). The previous reading carries forward in the meantime.</span>`;
  }
  return tmplFn(metric) + staleNote(metric);
}

// Inline "not refreshed" marker for a stale metric.
function staleNote(m, asOf) {
  if (!m || !m.stale) return '';
  const when = asOf || m.asOf || m.period;
  return ` <span class="cmhc-stale-inline" style="color:#b45309;font-style:italic">(not refreshed this cycle${when ? ` — last data ${escapeHtml(when)}` : ''})</span>`;
}

// --- Sentence templates (edit wording here) ---------------------------------
const T = {
  retail: (m) => `Retail trade in Manitoba ${moveBy(m.changePct, m.direction)} as of ${escapeHtml(m.period)} (${escapeHtml(m.comparison)}).`,
  manufacturing: (m) => `Manufacturing sales ${moveBy(m.changePct, m.direction)} as of ${escapeHtml(m.period)} (${escapeHtml(m.comparison)}).`,
  wholesale: (m) => `Wholesale trade ${moveBy(m.changePct, m.direction)} as of ${escapeHtml(m.period)} (${escapeHtml(m.comparison)}).`,
  farm: (m) => {
    return `Manitoba farm cash receipts in ${escapeHtml(m.period)} were ${upDown(m.totalChangePct)} versus the prior year. `
      + `Crop receipts were ${upDown(m.cropChangePct)} while livestock receipts were ${upDown(m.livestockChangePct)}.`;
  },
  gdp: (m) => `Preliminary estimates from the ${escapeHtml(m.source || 'Manitoba Bureau of Statistics')} show Manitoba's real Gross Domestic Product grew by approximately ${pct1(m.growthPct)} in ${escapeHtml(m.period)}${m.asOf ? ` (year-over-year average change, as of ${escapeHtml(m.asOf)})` : ''}.`,
  cpi: (m) => `The Manitoba Consumer Price Index (CPI — the inflation rate) is up ${pct1(m.changePct)} as of ${escapeHtml(m.period)} (${escapeHtml(m.comparison)}).`,
  employment: (m) => `Employment in Manitoba ${moveBy(m.changePct, m.direction)} (${escapeHtml(m.comparison)}) as of ${escapeHtml(m.period)}, with ${fmt0(m.value)} persons employed.`,
  unemployment: (m) => `The unemployment rate was ${pct1(m.value)} in ${escapeHtml(m.period)}`
    + (m.changePP != null ? `, ${m.changePP > 0 ? 'up' : m.changePP < 0 ? 'down' : 'unchanged'} ${Math.abs(m.changePP).toFixed(1)} percentage points ${escapeHtml(m.comparison)}.` : '.'),
  earnings: (m) => `Average weekly earnings ${moveBy(m.changePct, m.direction)} ${escapeHtml(m.comparison)} to ${dollars(m.value)}.`,
  exports: (m) => `Manitoba merchandise exports (domestic) were ${upDown(m.ytdChangePct != null ? m.ytdChangePct : m.changePct)} ${escapeHtml(m.period)} versus the same period a year earlier.`,
  minwage: (m) => `The Manitoba minimum wage rate is ${wage(m.value)} per hour (effective ${escapeHtml(m.effective)})`
    + (m.nextValue ? `, scheduled to rise to ${wage(m.nextValue)} on ${escapeHtml(m.nextEffective)}.` : '.'),
  starts: (m) => `Manitoba housing starts (all areas) were ${upDown(m.ytdChangePct)} ${escapeHtml(m.period)} versus the same period a year earlier.`,
  permits: (m) => `The seasonally adjusted value of Manitoba building permits ${moveBy(m.changePct, m.direction)} as of ${escapeHtml(m.period)} (${escapeHtml(m.comparison)}).`,

  mlsSales: (m) => `The WRREB reports ${fmt0(m.sales?.value)} MLS® sales in ${escapeHtml(m.asOf)} (${upDown(m.sales?.vsPriorYearPct)} from a year earlier and ${upDown(m.sales?.vs5yrAvgPct)} versus the 5-year average) and ${fmt0(m.active_listings?.value)} active listings (${upDown(m.active_listings?.vsPriorYearPct)} year-over-year and ${upDown(m.active_listings?.vs5yrAvgPct)} versus the 5-year average).`,
  mlsPrice: (label, p) => `The average ${label} price was ${dollars(p?.value)}, ${upDown(p?.vsPriorYearPct)} from a year earlier and ${upDown(p?.vs5yrAvgPct)} relative to the 5-year average.`,
  hpi: (h) => {
    if (!h || h.benchmarkLatest == null) return '';
    let s = `The MLS® Home Price Index single-family benchmark for Winnipeg was ${dollars(h.benchmarkLatest)}`
      + `${h.benchmarkLatestDate ? ` in ${escapeHtml(h.benchmarkLatestDate)}` : ''}`
      + (h.isRecordHigh ? ' — a record high for the series.' : '.');
    const bits = [];
    if (h.fiveYrChangePct != null)
      bits.push(`over the past five years the benchmark has ${h.fiveYrChangePct >= 0 ? 'risen' : 'fallen'} ${pct0(h.fiveYrChangePct)}`);
    if (!h.isRecordHigh && h.pctFromPeak != null && h.peakValue != null)
      bits.push(`it is ${upDown(h.pctFromPeak)} from its peak of ${dollars(h.peakValue)}${h.peakDate ? ` (${escapeHtml(h.peakDate)})` : ''}`);
    if (h.pctFromRecentLow != null && h.recentLowValue != null && h.pctFromRecentLow > 1)
      bits.push(`it sits ${pct0(h.pctFromRecentLow)} above its recent low of ${dollars(h.recentLowValue)}${h.recentLowDate ? ` (${escapeHtml(h.recentLowDate)})` : ''}`);
    if (bits.length) {
      const joined = bits.join(', and ');
      s += ' ' + joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
    }
    return s;
  },
};

// --- Module entry ------------------------------------------------------------
export async function initEconomicUpdate() {
  const $body = document.getElementById('eu-body');
  const $asof = document.getElementById('eu-asof');
  if (!$body) return;

  const data = await fetch('./data/economy/economic-update.json')
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!data) {
    $body.innerHTML = '<p class="text-sm text-red-700">Economic update data not found. Run <code>npm --prefix web run data:economic</code> (r/16 + r/15).</p>';
    return;
  }

  if ($asof) $asof.textContent = data.dataAsOf ? `Data as of ${data.dataAsOf}` : '';

  const ind = data.indicators || {};
  const hou = data.housing || {};
  const mls = data.mls || {};
  const intro = data.intro || {};
  const outlook = data.outlook || {};

  // ---- Build the narrative HTML ----
  const sections = [];   // {heading, paras:[html]}  — also used to build clipboard + word

  // Overview
  if (intro.winnipegCmaPopulation != null) {
    const cas = (intro.comparableAreas || [])
      .map(a => `${escapeHtml(a.name)} (${escapeHtml(a.type)}: ${fmt0(a.population)})`).join(', ');
    const overviewParas = [
      `Manitoba had a population of approximately ${fmt0(intro.provincePopulation)} according to the ${intro.censusYear} Census. `
      + `The Winnipeg Census Metropolitan Area (CMA) is the largest population centre at ${fmt0(intro.winnipegCmaPopulation)}, or roughly ${pct0(intro.winnipegSharePct)} of the province. `
      + (cas ? `Other major centres include ${cas}. ` : '')
      + `The provincial population grew ${pct1(intro.provinceGrowthSince2016Pct)} since the previous census, comparable to the national average (${pct1(intro.canadaGrowthSince2016Pct)}).`,
    ];
    if (intro.currentPopEstimate)
      overviewParas.push(`Statistics Canada's most recent quarterly estimate puts Manitoba's population at ${fmt0(intro.currentPopEstimate)}${intro.currentPopAsOf ? ` (as of ${escapeHtml(intro.currentPopAsOf)})` : ''}.`);
    sections.push({ heading: 'Overview', paras: overviewParas });
  }

  // Economic Overview
  const econParas = [];
  if (ind.minimum_wage) econParas.push(T.minwage(ind.minimum_wage));
  pushLine(econParas, indLine(ind.retail_trade, T.retail, 'Retail trade'));
  pushLine(econParas, indLine(ind.manufacturing_sales, T.manufacturing, 'Manufacturing sales'));
  pushLine(econParas, indLine(ind.wholesale_trade, T.wholesale, 'Wholesale trade'));
  pushLine(econParas, indLine(ind.farm_cash_receipts, T.farm, 'Farm cash receipts'));
  if (ind.real_gdp) econParas.push(T.gdp(ind.real_gdp));
  pushLine(econParas, indLine(ind.cpi, T.cpi, 'Consumer Price Index'));
  pushLine(econParas, indLine(ind.employment, T.employment, 'Employment'));
  pushLine(econParas, indLine(ind.unemployment_rate, T.unemployment, 'Unemployment rate'));
  pushLine(econParas, indLine(ind.weekly_earnings, T.earnings, 'Average weekly earnings'));
  pushLine(econParas, indLine(ind.exports, T.exports, 'Merchandise exports'));
  if (econParas.length) sections.push({ heading: 'Economic Overview', paras: econParas });

  // Housing & Construction
  const houParas = [];
  pushLine(houParas, indLine(hou.starts, T.starts, 'Housing starts'));
  pushLine(houParas, indLine(hou.building_permits, T.permits, 'Building permits'));
  if (houParas.length) sections.push({ heading: 'Housing & Construction', paras: houParas, figure: 'employment' });

  // Residential Real Estate
  const mlsParas = [];
  if (mls.sales) mlsParas.push(T.mlsSales(mls));
  if (mls.sfd_avg_price) mlsParas.push(T.mlsPrice('single-family detached', mls.sfd_avg_price));
  if (mls.sfa_avg_price) mlsParas.push(T.mlsPrice('single-family attached', mls.sfa_avg_price));
  if (mls.condo_avg_price) mlsParas.push(T.mlsPrice('condominium', mls.condo_avg_price));
  const hpiSentence = T.hpi(mls.hpi);
  if (mlsParas.length || hpiSentence) {
    sections.push({
      heading: 'Residential Real Estate (WRREB / CREA)',
      paras: mlsParas,
      banner: mls.stale ? `MLS® figures could not be refreshed this cycle — showing the last available data${mls.asOf ? ` (as of ${escapeHtml(mls.asOf)})` : ''}.` : null,
      figure: 'hpi',
      afterFigure: hpiSentence ? [hpiSentence] : [],
    });
  }

  // Economic Outlook (verbatim editorial)
  if (Array.isArray(outlook.paragraphs) && outlook.paragraphs.length) {
    sections.push({
      heading: 'Economic Outlook',
      paras: outlook.paragraphs.map(escapeHtml),
      note: outlook.source ? `Source: ${escapeHtml(outlook.source)}${outlook.published ? `, published ${escapeHtml(outlook.published)}` : ''}.` : null,
    });
  }

  // ---- Render to DOM ----
  let html = `<h2 class="cmhc-eu-title">Province of Manitoba — Overview &amp; Economic Outlook</h2>`;
  for (const s of sections) {
    html += `<section class="cmhc-eu-section">`;
    html += `<h3 class="cmhc-eu-heading">${escapeHtml(s.heading)}</h3>`;
    if (s.banner) html += `<div class="cmhc-stale-warning" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:0.85rem">${s.banner}</div>`;
    for (const p of s.paras) html += `<p class="cmhc-eu-para">${p}</p>`;
    if (s.figure === 'employment') html += `<div id="eu-fig-employment" class="cmhc-eu-figure"></div>`;
    if (s.figure === 'hpi') html += `<div id="eu-fig-hpi" class="cmhc-eu-figure"></div>`;
    for (const p of (s.afterFigure || [])) html += `<p class="cmhc-eu-para">${p}</p>`;
    if (s.note) html += `<p class="cmhc-eu-note text-xs text-neutral-500">${s.note}</p>`;
    html += `</section>`;
  }
  $body.innerHTML = html;

  // ---- Mount charts ----
  const charts = data.charts || {};
  let empCard = null, hpiCard = null;
  if (charts.employment && document.getElementById('eu-fig-employment')) {
    empCard = buildIndicatorCard(document.getElementById('eu-fig-employment'), {
      chartId: 'eu-employment', title: 'Figure 2 — Manitoba employment',
      sourceLabel: 'Statistics Canada (LFS, seasonally adjusted)', description: null,
    });
    empCard.render(charts.employment.records || [], charts.employment.series || [],
      { subtitle: 'Persons employed, seasonally adjusted', yearFrom: yearsAgo(5) });
  }
  if (charts.hpi_benchmark && document.getElementById('eu-fig-hpi')) {
    hpiCard = buildIndicatorCard(document.getElementById('eu-fig-hpi'), {
      chartId: 'eu-hpi', title: 'Figure 3 — WRREB single-family benchmark price',
      sourceLabel: 'CREA MLS® Home Price Index (Winnipeg board)', description: null,
    });
    hpiCard.render(charts.hpi_benchmark.records || [], charts.hpi_benchmark.series || [],
      { subtitle: 'Single-family benchmark, monthly', yearFrom: yearsAgo(5) });
  }

  // ---- Exports ----
  wireExports(sections, () => ({ emp: empCard?.card, hpi: hpiCard?.card }), data);
}

function yearsAgo(n) { return new Date().getFullYear() - n; }

// Plain-text version of a paragraph (strip the inline stale <span> etc.)
function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function buildClipboardHtml(sections, data) {
  let h = `<h2>Province of Manitoba — Overview &amp; Economic Outlook</h2>`;
  if (data.dataAsOf) h += `<p><em>Data as of ${escapeHtml(data.dataAsOf)}</em></p>`;
  for (const s of sections) {
    h += `<h3>${escapeHtml(s.heading)}</h3>`;
    for (const p of s.paras) h += `<p>${stripHtml(p)}</p>`;
    for (const p of (s.afterFigure || [])) h += `<p>${stripHtml(p)}</p>`;
  }
  return h;
}

function copyHtml(html) {
  const text = stripHtml(html);
  try {
    navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  } catch { navigator.clipboard?.writeText(text); }
}

function wireExports(sections, getCards, data) {
  const copyBtn = document.getElementById('eu-copy');
  const wordBtn = document.getElementById('eu-download-docx');

  copyBtn?.addEventListener('click', () => {
    copyHtml(buildClipboardHtml(sections, data));
    const orig = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = orig; }, 1500);
  });

  wordBtn?.addEventListener('click', async () => {
    const orig = wordBtn.textContent;
    wordBtn.disabled = true; wordBtn.textContent = 'Preparing…';
    try {
      const cards = getCards();
      const nodes = [cards.emp, cards.hpi].filter(Boolean);
      const caps = nodes.length ? await captureNodes(nodes) : [];
      const capByKey = {};
      if (cards.emp && caps.length) capByKey.employment = caps[nodes.indexOf(cards.emp)];
      if (cards.hpi && caps.length) capByKey.hpi = caps[nodes.indexOf(cards.hpi)];

      // Build ordered blocks for the Word document.
      const blocks = [{ type: 'title', text: 'Province of Manitoba — Overview & Economic Outlook' }];
      if (data.dataAsOf) blocks.push({ type: 'meta', text: `Data as of ${data.dataAsOf}` });
      for (const s of sections) {
        blocks.push({ type: 'heading', text: s.heading });
        for (const p of s.paras) blocks.push({ type: 'para', text: stripHtml(p) });
        if (s.figure && capByKey[s.figure]) blocks.push({ type: 'image', capture: capByKey[s.figure] });
        for (const p of (s.afterFigure || [])) blocks.push({ type: 'para', text: stripHtml(p) });
      }
      const { exportNarrativeToWord } = await import('./word-export.js');
      await exportNarrativeToWord(blocks, { filename: `MB_Economic_Update_${new Date().toISOString().slice(0, 10)}.docx` });
    } catch (err) {
      console.error('[economic-update word export]', err);
    } finally {
      wordBtn.disabled = false; wordBtn.textContent = orig;
    }
  });
}
