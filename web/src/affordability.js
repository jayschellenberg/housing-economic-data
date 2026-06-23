/*
 * Affordability view — a housing Affordability Factor (Royal LePage style) for
 * Manitoba: the monthly housing payment as a % of before-tax household income,
 * with 30% as the affordability line.
 *   - Rental  factor = median monthly rent / monthly median household income
 *   - Purchase factor = monthly mortgage payment / monthly median household income
 *     (mortgage = home price, 20% down, 25-yr amortization, an adjustable rate)
 *
 * Income + rent come from the 2021 Census (census_profile.json) at the province,
 * CMA/CA, municipality (CSD) and Winnipeg-neighbourhood levels. Home prices are
 * MLS HPI (mls_benchmark.json) — currently Winnipeg only, so purchase affordability
 * shows for Winnipeg and "**" elsewhere until more MB prices are added. The
 * mortgage rate defaults to 4.64% (the Royal LePage 2026 report assumption);
 * the latest Bank of Canada conventional rates are offered as reference.
 */

import * as Plot from '@observablehq/plot';
import { themed, frameMark, PALETTE } from './plot-theme.js';

const DEFAULT_RATE = 4.64;     // % — Royal LePage 2026 report assumption (3-yr fixed special)
const DOWN_PCT     = 20;       // % down payment
const AMORT_YEARS  = 25;       // amortization
const AFFORD_LINE  = 30;       // % of income = the affordability threshold

const miss = (v) => v == null || !Number.isFinite(Number(v));
const fPct = (v) => miss(v) ? '**' : `${Number(v).toFixed(1)}%`;
const fUsd = (v) => miss(v) ? '**' : `$${Math.round(Number(v)).toLocaleString()}`;

// Monthly payment to amortize `principal` at annual `ratePct` over `years`.
function monthlyPayment(principal, ratePct, years) {
  const r = ratePct / 100 / 12, n = years * 12;
  if (!(principal > 0)) return null;
  if (r === 0) return principal / n;
  const f = Math.pow(1 + r, n);
  return principal * r * f / (f - 1);
}

export async function initAffordability() {
  const $area    = document.getElementById('aff-area');
  const $tenure  = document.querySelectorAll('input[name="affTenure"]');
  const $rate    = document.getElementById('aff-rate');
  const $rateRef = document.getElementById('aff-rate-ref');
  const $headline = document.getElementById('aff-headline');
  const $charts  = document.getElementById('aff-chart-grid');
  const $tables  = document.getElementById('aff-tables');
  if (!$area || !$tables) return;

  const [profile, mls, mortgage] = await Promise.all([
    fetch('./data/housing/census_profile.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('./data/economy/mls_benchmark.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('./data/indicators/mortgage_market.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (!profile || !Array.isArray(profile.regions)) {
    $tables.innerHTML = '<p class="text-sm text-red-700">Census profile data not found.</p>';
    return;
  }

  // --- Area model: income + rent from the newest census year per region -------
  const LEVEL_GROUP = {
    PR: 'Province', CMA: 'CMAs / CAs', CD: 'Census divisions', CSD: 'Municipalities',
    WPG_CA: 'Winnipeg — Community Areas', WPG_Cluster: 'Winnipeg — Clusters', WPG_Nbhd: 'Winnipeg — Neighbourhoods',
  };
  const GROUP_ORDER = ['Province', 'CMAs / CAs', 'Municipalities', 'Census divisions',
                       'Winnipeg — Community Areas', 'Winnipeg — Clusters', 'Winnipeg — Neighbourhoods'];
  const newestDemo = (r) => {
    const yrs = Object.keys(r.demo || {}).filter(y => r.demo[y]?.median_hh_income != null).sort();
    const y = yrs[yrs.length - 1];
    return y ? { year: y, ...r.demo[y] } : null;
  };
  const areas = [];
  for (const r of profile.regions) {
    const d = newestDemo(r);
    if (!d) continue;
    areas.push({
      uid: String(r.uid), name: r.name, level: r.level, group: LEVEL_GROUP[r.level] || r.level,
      year: d.year, income: d.median_hh_income, rent: d.median_rent,
    });
  }
  const byUid = new Map(areas.map(a => [a.uid, a]));

  // --- Home prices (MLS HPI) keyed onto the matching area uids ----------------
  // Today: Winnipeg single-family benchmark → Winnipeg CMA (46602) + Winnipeg CSD (4611040).
  const priceByUid = new Map();
  const wpgPrice = (mls?.series || []).find(s => /winnipeg/i.test(s.geo))?.latestValue;
  if (wpgPrice) { priceByUid.set('46602', wpgPrice); priceByUid.set('4611040', wpgPrice); }
  const priceAsOf = (mls?.series || []).find(s => /winnipeg/i.test(s.geo))?.latestDate || mls?.asOf;

  // --- Reference mortgage rates (Bank of Canada) ------------------------------
  const latestOf = (id) => {
    const recs = (mortgage?.records || []).filter(x => x.id === id);
    return recs.length ? recs[recs.length - 1].value : null;
  };
  const rate5 = latestOf('boc.mortgage5yr'), rate3 = latestOf('boc.mortgage3yr');
  if ($rateRef) {
    const parts = [];
    if (rate3) parts.push(`BoC 3-yr ${rate3.toFixed(2)}%`);
    if (rate5) parts.push(`BoC 5-yr ${rate5.toFixed(2)}%`);
    $rateRef.textContent = parts.length ? `Reference (posted): ${parts.join(' · ')}` : '';
  }

  // --- State ------------------------------------------------------------------
  const state = { uid: '', tenure: 'both', rate: DEFAULT_RATE };

  // Area dropdown, grouped by level.
  const opt = (a) => `<option value="${escapeHtml(a.uid)}">${escapeHtml(a.name)}</option>`;
  const grouped = GROUP_ORDER.map(g => {
    const arr = areas.filter(a => a.group === g).sort((x, y) => x.name.localeCompare(y.name));
    return arr.length ? `<optgroup label="${escapeHtml(g)}">${arr.map(opt).join('')}</optgroup>` : '';
  }).join('');
  $area.innerHTML = grouped;
  state.uid = byUid.has('46602') ? '46602' : (areas[0]?.uid || '');   // default Winnipeg CMA
  $area.value = state.uid;
  if ($rate) $rate.value = state.rate;

  // --- Per-area affordability computation -------------------------------------
  function factors(a) {
    if (!a) return null;
    const mInc = a.income ? a.income / 12 : null;
    const rentFactor = (mInc && a.rent != null) ? a.rent / mInc * 100 : null;
    const price = priceByUid.get(a.uid) ?? null;
    const payment = price != null ? monthlyPayment(price * (1 - DOWN_PCT / 100), state.rate, AMORT_YEARS) : null;
    const buyFactor = (mInc && payment != null) ? payment / mInc * 100 : null;
    return { ...a, mInc, rentFactor, price, payment, buyFactor };
  }
  const band = (f) => miss(f) ? '' : f < AFFORD_LINE ? 'aff-ok' : f < 50 ? 'aff-warn' : 'aff-bad';
  const bandWord = (f) => miss(f) ? 'no data' : f < AFFORD_LINE ? 'affordable' : f < 50 ? 'burdened' : 'severely burdened';

  // --- Render -----------------------------------------------------------------
  function render() {
    const sel = factors(byUid.get(state.uid));
    const showRent = state.tenure !== 'purchase';
    const showBuy  = state.tenure !== 'rental';

    renderHeadline(sel, showRent, showBuy);
    renderChart(showRent, showBuy);
    renderTable(sel, showRent, showBuy);
  }

  function renderHeadline(sel, showRent, showBuy) {
    if (!sel) { $headline.innerHTML = ''; return; }
    const card = (label, factor, sub) => `
      <div class="aff-stat ${band(factor)}">
        <div class="aff-stat-label">${escapeHtml(label)}</div>
        <div class="aff-stat-value">${fPct(factor)}</div>
        <div class="aff-stat-sub">${sub}</div>
      </div>`;
    const cards = [];
    if (showRent) cards.push(card('Rental', sel.rentFactor,
      miss(sel.rentFactor) ? 'no income/rent data' : `${fUsd(sel.rent)}/mo · ${bandWord(sel.rentFactor)}`));
    if (showBuy) cards.push(card('Purchase', sel.buyFactor,
      miss(sel.buyFactor) ? 'no home-price data' : `${fUsd(sel.payment)}/mo · ${bandWord(sel.buyFactor)}`));
    $headline.innerHTML = `
      <div class="cmhc-hsk-title">${escapeHtml(sel.name)} — affordability <span>(${escapeHtml(sel.year)} income, ${state.rate.toFixed(2)}% mortgage)</span></div>
      <div class="aff-stat-row">${cards.join('')}</div>
      <p class="text-xs text-neutral-500 mt-1">Affordability Factor = housing payment as % of median household income; under ${AFFORD_LINE}% is considered affordable. Median income <strong>${fUsd(sel.income)}</strong>${sel.price != null ? ` · home price <strong>${fUsd(sel.price)}</strong>` : ''}.</p>`;
  }

  // Ranking bars across the province + CMAs (+ the selected area if it's elsewhere).
  function tableAreas(sel) {
    const base = areas.filter(a => a.level === 'PR' || a.level === 'CMA');
    if (sel && !base.some(a => a.uid === sel.uid)) base.push(byUid.get(sel.uid));
    return base.map(factors);
  }

  function renderChart(showRent, showBuy) {
    $charts.replaceChildren();
    const rows = tableAreas(factors(byUid.get(state.uid)));
    const key = showBuy && !showRent ? 'buyFactor' : 'rentFactor';
    const label = key === 'buyFactor' ? 'Purchase' : 'Rental';
    const data = rows.filter(r => !miss(r[key])).map(r => ({ area: r.name, value: r[key] }));
    if (!data.length) return;
    const maxV = Math.max(AFFORD_LINE + 5, ...data.map(d => d.value));
    const svg = Plot.plot(themed({
      height: Math.max(140, data.length * 26 + 40), marginLeft: 150, marginBottom: 30,
      x: { label: `${label} Affordability Factor (% of income)`, domain: [0, maxV], tickFormat: v => `${v}%` },
      y: { label: null, domain: data.slice().sort((a, b) => a.value - b.value).map(d => d.area) },
      marks: [
        Plot.gridX({ stroke: '#e5e7eb' }),
        Plot.barX(data, { x: 'value', y: 'area', fill: PALETTE[0], sort: { y: '-x' } }),
        Plot.ruleX([AFFORD_LINE], { stroke: '#dc2626', strokeDasharray: '4,3' }),
        frameMark(),
      ],
    }));
    const card = document.createElement('section');
    card.className = 'chart-card';
    card.innerHTML = `<header class="chart-title">${label} affordability — Manitoba</header>
      <p class="chart-sub">Housing payment as % of median household income · red line = ${AFFORD_LINE}% affordability threshold</p>
      <div data-role="plot"></div>
      <div class="chart-caption"><span class="chart-caption-left"></span>
        <span class="chart-source">Source: StatsCan Census, CMHC/CREA, Bank of Canada</span></div>`;
    card.querySelector('[data-role="plot"]').appendChild(svg);
    $charts.appendChild(card);
  }

  function renderTable(sel, showRent, showBuy) {
    const rows = tableAreas(sel).sort((a, b) => {
      const k = showBuy && !showRent ? 'buyFactor' : 'rentFactor';
      const av = miss(a[k]) ? Infinity : a[k], bv = miss(b[k]) ? Infinity : b[k];
      return av - bv;
    });
    const head = ['Area', 'Median income'];
    if (showRent) head.push('Median rent', 'Rental factor');
    if (showBuy)  head.push('Home price', 'Mortgage / mo', 'Purchase factor');
    const body = rows.map(r => {
      const cells = [`<td>${escapeHtml(r.name)}</td>`, `<td>${fUsd(r.income)}</td>`];
      if (showRent) cells.push(`<td>${fUsd(r.rent)}</td>`, `<td class="${band(r.rentFactor)}">${fPct(r.rentFactor)}</td>`);
      if (showBuy)  cells.push(`<td>${fUsd(r.price)}</td>`, `<td>${fUsd(r.payment)}</td>`, `<td class="${band(r.buyFactor)}">${fPct(r.buyFactor)}</td>`);
      const hi = r.uid === state.uid ? ' class="aff-row-selected"' : '';
      return `<tr${hi}>${cells.join('')}</tr>`;
    }).join('');
    $tables.innerHTML = `
      <section class="cmhc-table-block">
        <div class="cmhc-table-title">Affordability Factor — Manitoba (ranked, most affordable first)</div>
        <table class="cmhc-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
        <p class="text-xs text-neutral-500 mt-2">Income &amp; rent: ${escapeHtml(rows[0]?.year || '2021')} Census. Mortgage: ${DOWN_PCT}% down, ${AMORT_YEARS}-yr amortization at ${state.rate.toFixed(2)}%${priceAsOf ? `; price as of ${escapeHtml(String(priceAsOf).slice(0, 7))}` : ''}. Purchase factor shows only where a home-price benchmark exists (Winnipeg).</p>
      </section>`;
  }

  // --- Events -----------------------------------------------------------------
  $area.addEventListener('change', () => { state.uid = $area.value; render(); });
  $tenure.forEach(n => n.addEventListener('change', () => { if (n.checked) { state.tenure = n.value; render(); } }));
  $rate?.addEventListener('change', () => {
    const v = parseFloat($rate.value);
    state.rate = Number.isFinite(v) && v > 0 ? v : DEFAULT_RATE;
    render();
  });
  render();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
