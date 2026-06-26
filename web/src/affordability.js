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
import { downloadCard } from './chart.js';

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

  const [profile, mls, mortgage, extra] = await Promise.all([
    fetch('./data/housing/census_profile.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('./data/economy/mls_benchmark.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('./data/indicators/mortgage_market.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('./data/economy/affordability_extra.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (!profile || !Array.isArray(profile.regions)) {
    $tables.innerHTML = '<p class="text-sm text-red-700">Census profile data not found.</p>';
    return;
  }

  // --- Area model: income + rent per area, grouped by province + level --------
  const PROV_LABEL = { '46': 'Manitoba', '47': 'Saskatchewan', '48': 'Alberta', '59': 'British Columbia' };
  const LEVEL_LABEL = {
    PR: 'Province', CMA: 'CMAs / CAs', CD: 'Census divisions', CSD: 'Municipalities',
    WPG_CA: 'Winnipeg — Community Areas', WPG_Cluster: 'Winnipeg — Clusters', WPG_Nbhd: 'Winnipeg — Neighbourhoods',
  };
  const groupOf = (prov, level) => `${PROV_LABEL[prov] || prov} · ${LEVEL_LABEL[level] || level}`;
  const GROUP_ORDER = [];
  for (const p of ['46', '47', '48', '59'])
    for (const lv of ['PR', 'CMA', 'CSD', 'CD', 'WPG_CA', 'WPG_Cluster', 'WPG_Nbhd']) GROUP_ORDER.push(groupOf(p, lv));

  const newestDemo = (r) => {
    const yrs = Object.keys(r.demo || {}).filter(y => r.demo[y]?.median_hh_income != null).sort();
    const y = yrs[yrs.length - 1];
    return y ? { year: y, ...r.demo[y] } : null;
  };
  // CMHC average rent for MB centres (keyed by census_profile uid) — pairs with
  // the census median rent so MB & SK centre factors share the CMHC basis.
  const mbCmhc = new Map((extra?.mbCmhcRent || []).map(m => [String(m.uid), m]));
  // Strip cancensus type codes from region names (same as the Census Profile
  // tab): "Manitoba (Man.)" → "Manitoba", "Winnipeg (B)" → "Winnipeg (CMA)",
  // "Brandon (D)" → "Brandon (CA)". CSD codes are kept (they disambiguate
  // same-named municipalities).
  const cleanName = (name, level) => {
    let n = String(name || '').replace(/\s{2,}/g, ' ').trim();
    if (level === 'PR')  n = n.replace(/\s*\([^)]*\)$/, '');
    if (level === 'CMA') n = n.replace(/\s*\(B\)$/, ' (CMA)').replace(/\s*\((D|K)\)$/, ' (CA)');
    if (level === 'CD')  n = n.replace(/\s*\(CDR\)$/, '');
    return n;
  };
  const provOfUid = (uid) => /^WPG/.test(String(uid)) ? '46' : String(uid).slice(0, 2);
  const areas = [];
  for (const r of profile.regions) {                // census income + median rent (CMHC avg rent for MB centres)
    // census_profile.json carries Manitoba in full plus SK/AB/BC at PR/CMA/CD
    // and municipality (CSD) level. The province/CMA rows for SK/AB/BC come from
    // affordability_extra below (they carry CMHC current rent), so from the
    // census file we take Manitoba (all levels + Winnipeg virtual geos) and only
    // the SK/AB/BC municipalities — the rows extra doesn't cover — to avoid
    // duplicating the province/CMA totals.
    const uid = String(r.uid);
    const isMB = /^(46|WPG)/.test(uid);
    const isWesternCsd = r.level === 'CSD' && /^(47|48|59)/.test(uid);
    if (!isMB && !isWesternCsd) continue;
    const d = newestDemo(r);
    if (!d) continue;
    const prov = provOfUid(uid);
    const cmhc = mbCmhc.get(uid);                   // MB centres only; null for municipalities/other provinces
    areas.push({
      uid, name: cleanName(r.name, r.level), level: r.level, prov,
      group: groupOf(prov, r.level), year: d.year, income: d.median_hh_income,
      medianRent: d.median_rent, avgRent: cmhc?.avgRent ?? null, avgRentYear: cmhc?.rentYear ?? null,
    });
  }
  for (const a of (extra?.sk || [])) {              // Saskatchewan — census income + CMHC current rent (average only)
    areas.push({
      uid: String(a.uid), name: a.name, level: a.level, prov: '47',
      group: groupOf('47', a.level), year: a.incomeYear || '2021', income: a.income,
      medianRent: null, avgRent: a.rent ?? null, avgRentYear: a.rentYear ?? null,
    });
  }
  for (const [arr, prov] of [[extra?.ab, '48'], [extra?.bc, '59']]) {   // Alberta + BC — same basis as SK
    for (const a of (arr || [])) {
      areas.push({
        uid: String(a.uid), name: a.name, level: a.level, prov,
        group: groupOf(prov, a.level), year: a.incomeYear || '2021', income: a.income,
        medianRent: null, avgRent: a.rent ?? null, avgRentYear: a.rentYear ?? null,
      });
    }
  }
  const byUid = new Map(areas.map(a => [a.uid, a]));

  // --- Home prices (MLS HPI) keyed onto the matching area uids ----------------
  // Today: Winnipeg single-family benchmark → Winnipeg CMA (46602) + Winnipeg CSD (4611040).
  const priceByUid = new Map();
  // CREA single-family benchmark series geo → affordability area uid(s).
  const MLS_UID = {
    winnipeg: ['46602', '4611040'], calgary: ['48825'], edmonton: ['48835'],
    saskatoon: ['47725'], regina: ['47705'], vancouver: ['59933'], victoria: ['59935'],
  };
  for (const s of (mls?.series || [])) {
    const uids = MLS_UID[String(s.geo || '').toLowerCase()];
    if (uids && s.latestValue != null) for (const u of uids) priceByUid.set(u, s.latestValue);
  }
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

  // Province + area cascade. The province <select> scopes the area list to one
  // province (Manitoba additionally carries the Winnipeg virtual geos), so the
  // ~970 SK/AB/BC municipalities don't swamp one flat dropdown.
  const $prov = document.getElementById('aff-prov');
  const provsPresent = ['46', '47', '48', '59'].filter(p => areas.some(a => a.prov === p));
  const fillProv = (prov) => {
    if ($prov) $prov.innerHTML = provsPresent
      .map(p => `<option value="${p}">${escapeHtml(PROV_LABEL[p] || p)}</option>`).join('');
    if ($prov) $prov.value = prov;
  };
  const fillArea = (prov, defaultUid) => {
    const opt = (a) => `<option value="${escapeHtml(a.uid)}">${escapeHtml(a.name)}</option>`;
    $area.innerHTML = GROUP_ORDER
      .filter(g => areas.some(a => a.prov === prov && a.group === g))
      .map(g => {
        const arr = areas.filter(a => a.prov === prov && a.group === g).sort((x, y) => x.name.localeCompare(y.name));
        return `<optgroup label="${escapeHtml(g)}">${arr.map(opt).join('')}</optgroup>`;
      }).join('');
    if (defaultUid && areas.some(a => a.uid === defaultUid && a.prov === prov)) $area.value = defaultUid;
    state.uid = $area.value;
  };
  fillProv('46');
  fillArea('46', byUid.has('46602') ? '46602' : (areas.find(a => a.prov === '46')?.uid || areas[0]?.uid || ''));  // default Winnipeg CMA
  if ($rate) $rate.value = state.rate;

  // --- Per-area affordability computation -------------------------------------
  // Rental factor uses CMHC average rent where available (MB centres + SK), else
  // the census median rent (MB municipalities) — so centre factors are comparable.
  function factors(a) {
    if (!a) return null;
    const mInc = a.income ? a.income / 12 : null;
    const rentUsed = a.avgRent ?? a.medianRent ?? null;
    const rentBasis = a.avgRent != null ? 'CMHC' : (a.medianRent != null ? 'census' : null);
    const rentFactor = (mInc && rentUsed != null) ? rentUsed / mInc * 100 : null;
    const price = priceByUid.get(a.uid) ?? null;
    const payment = price != null ? monthlyPayment(price * (1 - DOWN_PCT / 100), state.rate, AMORT_YEARS) : null;
    const buyFactor = (mInc && payment != null) ? payment / mInc * 100 : null;
    return { ...a, mInc, rentUsed, rentBasis, rentFactor, price, payment, buyFactor };
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
      miss(sel.rentFactor) ? 'no income/rent data' : `${fUsd(sel.rentUsed)}/mo (${sel.rentBasis === 'CMHC' ? 'CMHC avg' : 'census median'}) · ${bandWord(sel.rentFactor)}`));
    if (showBuy) cards.push(card('Purchase', sel.buyFactor,
      miss(sel.buyFactor) ? 'no home-price data' : `${fUsd(sel.payment)}/mo · ${bandWord(sel.buyFactor)}`));
    $headline.innerHTML = `
      <div class="cmhc-hsk-title">${escapeHtml(sel.name)} — affordability <span>(${escapeHtml(sel.year)} income, ${state.rate.toFixed(2)}% mortgage)</span></div>
      <div class="aff-stat-row">${cards.join('')}</div>
      <p class="text-xs text-neutral-500 mt-1">Affordability Factor = housing payment as % of median household income; under ${AFFORD_LINE}% is considered affordable. Median income <strong>${fUsd(sel.income)}</strong>${sel.price != null ? ` · home price <strong>${fUsd(sel.price)}</strong>` : ''}.</p>`;
  }

  // Ranking: the selected area's OWN province only — its province total + that
  // province's CMAs, plus the selected area itself if it's a municipality /
  // neighbourhood. Manitoba and Saskatchewan are never mixed in one view.
  function tableAreas(sel) {
    const prov = sel?.prov;
    const base = areas.filter(a => (a.level === 'PR' || a.level === 'CMA') && a.prov === prov);
    if (sel && !base.some(a => a.uid === sel.uid)) base.push(byUid.get(sel.uid));
    return base.map(factors);
  }

  function renderChart(showRent, showBuy) {
    $charts.replaceChildren();
    const sel = byUid.get(state.uid);
    const provName = PROV_LABEL[sel?.prov] || '';
    const rows = tableAreas(factors(sel));
    const key = showBuy && !showRent ? 'buyFactor' : 'rentFactor';
    const label = key === 'buyFactor' ? 'Purchase' : 'Rental';
    const data = rows.filter(r => !miss(r[key])).map(r => ({ area: r.name, value: r[key] }));
    if (!data.length) return;
    const maxV = Math.max(AFFORD_LINE + 5, ...data.map(d => d.value));
    const svg = Plot.plot(themed({
      height: Math.max(240, data.length * 30 + 70), marginTop: 10, marginLeft: 140, marginBottom: 44, marginRight: 18,
      x: { label: '% of household income →', domain: [0, maxV], tickFormat: v => `${v}%` },
      y: { label: null, domain: data.slice().sort((a, b) => a.value - b.value).map(d => d.area) },
      marks: [
        Plot.gridX({ stroke: '#e5e7eb' }),
        Plot.barX(data, { x: 'value', y: 'area', fill: PALETTE[0], sort: { y: '-x' } }),
        Plot.ruleX([AFFORD_LINE], { stroke: '#dc2626', strokeDasharray: '4,3' }),
        frameMark(),
      ],
    }));
    svg.style.overflow = 'visible';                 // don't clip the x-axis label at the viewBox edge
    const card = document.createElement('section');
    card.className = 'chart-card';
    card.innerHTML = `<header class="chart-title">${label} affordability — ${escapeHtml(provName)}</header>
      <p class="chart-sub">Housing payment as % of median household income · red line = ${AFFORD_LINE}% affordability threshold</p>
      <div data-role="plot" class="cmhc-plot"></div>
      <div class="chart-caption"><span class="chart-caption-left"></span>
        <span class="chart-source">Source: StatsCan Census, CMHC/CREA, Bank of Canada</span></div>
      <div class="chart-actions"><button type="button" data-role="dl-png">Download PNG</button></div>`;
    card.querySelector('[data-role="plot"]').appendChild(svg);
    const fname = `affordability_${label}_${provName}_${new Date().toISOString().slice(0, 10)}.png`.replace(/\s+/g, '-');
    card.querySelector('[data-role="dl-png"]').onclick = () => downloadCard(card, fname, 'png');
    $charts.appendChild(card);
  }

  function renderTable(sel, showRent, showBuy) {
    const rows = tableAreas(sel).sort((a, b) => {
      const k = showBuy && !showRent ? 'buyFactor' : 'rentFactor';
      const av = miss(a[k]) ? Infinity : a[k], bv = miss(b[k]) ? Infinity : b[k];
      return av - bv;
    });
    const head = ['Area', 'Prov.', 'Median income'];
    if (showRent) head.push('Median rent', 'Avg rent (CMHC)', 'Rental factor');
    if (showBuy)  head.push('Home price', 'Mortgage / mo', 'Purchase factor');
    const body = rows.map(r => {
      const cells = [`<td>${escapeHtml(r.name)}</td>`, `<td>${escapeHtml(PROV_LABEL[r.prov] || '')}</td>`, `<td>${fUsd(r.income)}</td>`];
      if (showRent) cells.push(`<td>${fUsd(r.medianRent)}</td>`, `<td>${fUsd(r.avgRent)}</td>`, `<td class="${band(r.rentFactor)}">${fPct(r.rentFactor)}</td>`);
      if (showBuy)  cells.push(`<td>${fUsd(r.price)}</td>`, `<td>${fUsd(r.payment)}</td>`, `<td class="${band(r.buyFactor)}">${fPct(r.buyFactor)}</td>`);
      const hi = r.uid === state.uid ? ' class="aff-row-selected"' : '';
      return `<tr${hi}>${cells.join('')}</tr>`;
    }).join('');
    $tables.innerHTML = `
      <section class="cmhc-table-block">
        <div class="cmhc-table-title">Affordability Factor — ${escapeHtml(PROV_LABEL[sel?.prov] || '')} (ranked, most affordable first)</div>
        <table class="cmhc-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
        <p class="text-xs text-neutral-500 mt-2">Income: 2021 Census (2020 income). <strong>Median rent</strong> = 2021 Census median shelter cost (Manitoba + SK/AB/BC municipalities, where reported). <strong>Avg rent (CMHC)</strong> = current CMHC average rent, all bedroom types (centres only). The <strong>rental factor uses CMHC average rent where available</strong> (province + major centres — comparable) and the census median otherwise. Mortgage: ${DOWN_PCT}% down, ${AMORT_YEARS}-yr amortization at ${state.rate.toFixed(2)}%${priceAsOf ? `; price as of ${escapeHtml(String(priceAsOf).slice(0, 7))}` : ''}. Purchase factor shows only where a home-price benchmark exists (Winnipeg, Calgary, Edmonton, Saskatoon, Regina, Vancouver, Victoria). SK/AB/BC outside those centres are census income + median rent.</p>
      </section>`;
  }

  // --- Events -----------------------------------------------------------------
  $prov?.addEventListener('change', () => { fillArea($prov.value); render(); });   // repopulate scoped area list
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
