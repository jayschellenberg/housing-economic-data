/*
 * FCC Farmland tab — Farm Credit Canada's farmland values: the annual % change
 * in cultivated land values for Canada and each province (1986 on), the FCC
 * reference value per acre by region (1997 on), each year's published value
 * ranges and pastureland values, and the report's narrative for every
 * province and year.
 *
 * NO FCC DATA SHIPS WITH THE SITE. FCC-Farmland/ingest/run.bat parses the
 * report PDFs into fcc_farmland.json and publishes it to
 * SharedInfo\AppMarketData\FCCFarmland; the user nominates that folder here
 * and the browser reads it locally (fcc-store.js), as the Johnson Report and
 * Rentals.ca tabs do.
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { downloadCardPng, setExportRedraw, setExportCropHeight, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import { buildJumpBar } from './jump-bar.js';
import {
  SOURCE, CANADA, DEFAULT_PROV, CHANGE_YEARS, GROUPS, LAND_LABEL, periodLabel, provName, changeIndex, regionIndex, provRegions,
  years, changeCardInput, regionCardInput, regionChangeCardInput, regionTableRows, changeTable, narrativesFor, narrativeYears,
  markRegions, fmtMoney, fmtPct, fmtRange,
} from './fcc-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getManifest, clearFcc,
} from './fcc-store.js';

const PREF_KEY = 'fcc.v1';
// The site-wide home province is an SGC code; FCC's tables use postal codes.
const SGC_TO_POSTAL = { 10: 'NL', 11: 'PE', 12: 'NS', 13: 'NB', 24: 'QC', 35: 'ON', 46: 'MB', 47: 'SK', 48: 'AB', 59: 'BC' };
// The % change table shows this many years when no "from" year is set.
const TABLE_YEARS = 15;

let ui = null;

function loadPrefs() {
  const p = getPref(PREF_KEY);
  return p && typeof p === 'object' ? p : {};
}
function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  setPref(PREF_KEY, next);
  return next;
}

// --- Init --------------------------------------------------------------------

export async function initFcc() {
  const $status = document.getElementById('fc-folder-status');
  const $grid = document.getElementById('fc-chart-grid');
  if (!$status || !$grid) return;
  ui = {
    $status, $grid,
    $error: document.getElementById('fc-folder-error'),
    $pick: document.getElementById('fc-pick-folder'),
    $pickFallback: document.getElementById('fc-pick-fallback'),
    $rescan: document.getElementById('fc-rescan'),
    $clear: document.getElementById('fc-clear'),
    $folderToggle: document.getElementById('fc-folder-toggle'),
    $folderBody: document.getElementById('fc-folder-body'),
    $prov: document.getElementById('fc-prov'),
    $year: document.getElementById('fc-year'),
    $yearFrom: document.getElementById('fc-year-from'),
    $allNarr: document.getElementById('fc-all-narratives'),
    $sectionMenu: document.getElementById('fc-section-menu'),
    $sections: document.getElementById('fc-section-toggles'),
    $sectionSummary: document.getElementById('fc-section-summary-text'),
    $xlsx: document.getElementById('fc-download-xlsx'),
    $empty: document.getElementById('fc-empty'),
    $about: document.getElementById('fc-about'),
    data: null,
    cIdx: new Map(),
    rIdx: new Map(),
    cards: new Map(),
    prefs: loadPrefs(),
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the FCC data locally (IndexedDB is unavailable).');
    return;
  }
  wireControls();
  await loadFromStore();
  await maybeAutoRefresh();
}

function showError(msg) {
  ui.$error.textContent = msg || '';
  ui.$error.hidden = !msg;
}
function setStatus(text) { ui.$status.textContent = text; }

// --- Folder ------------------------------------------------------------------

function wireControls() {
  const { $pick, $pickFallback, $rescan, $clear } = ui;
  if (fsAccessSupported()) {
    $pick.hidden = false; $pickFallback.hidden = true;
    $pick.addEventListener('click', async () => {
      showError('');
      try { await runImport(await pickDirectory(), { force: true }); }
      catch (err) { if (err?.name !== 'AbortError') showError(err?.message || String(err)); }
    });
    $rescan.addEventListener('click', async () => {
      showError('');
      const handle = await getSavedDirectory();
      if (!handle) { showError('No folder is saved yet — choose the FCCFarmland folder first.'); return; }
      if ((await directoryPermission(handle, { request: true })) !== 'granted') { showError('Access to the saved folder was not granted.'); return; }
      try { await runImport(handle, { force: true }); } catch (err) { showError(err?.message || String(err)); }
    });
  } else {
    $pick.hidden = true; $pickFallback.hidden = false; $rescan.hidden = true;
    $pickFallback.addEventListener('change', async () => {
      showError('');
      try {
        setStatus('Reading…');
        const summary = await importFromFileList($pickFallback.files);
        await loadFromStore();
        setStatus(summaryText(summary));
      } catch (err) { showError(err?.message || String(err)); }
      finally { $pickFallback.value = ''; }
    });
  }
  $clear.addEventListener('click', async () => {
    await clearFcc();
    ui.data = null;
    ui.cIdx = new Map();
    ui.rIdx = new Map();
    renderAll();
    setStatus(noDataText());
    $clear.hidden = true;
  });
  ui.$folderToggle.addEventListener('click', () => {
    ui.prefs = savePrefs({ folderCollapsed: !ui.prefs.folderCollapsed });
    renderFolderBody();
  });
  ui.$prov.addEventListener('change', () => { ui.prefs = savePrefs({ prov: ui.$prov.value }); renderCharts(); });
  ui.$year.addEventListener('change', () => { ui.prefs = savePrefs({ year: Number(ui.$year.value) || null }); renderCharts(); });
  ui.$yearFrom.addEventListener('change', () => { ui.prefs = savePrefs({ yearFrom: Number(ui.$yearFrom.value) || null }); renderCharts(); });
  ui.$allNarr.addEventListener('change', () => { ui.prefs = savePrefs({ allNarratives: ui.$allNarr.checked }); renderCharts(); });
  document.getElementById('fc-sections-all').addEventListener('click', () => setGroups(GROUPS.map(g => g.id)));
  document.getElementById('fc-sections-none').addEventListener('click', () => setGroups([]));
  const $menu = ui.$sectionMenu;
  document.addEventListener('click', (e) => { if ($menu.open && !$menu.contains(e.target)) $menu.open = false; });
  $menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $menu.open = false; $menu.querySelector('summary').focus(); } });
  ui.$xlsx?.addEventListener('click', () => exportData().catch(err => {
    console.error('[fcc excel]', err);
    showError('Excel export failed: ' + (err?.message || err));
  }));
}

async function runImport(handle, { force = false } = {}) {
  setStatus('Reading folder…');
  const summary = await importFromDirectory(handle, { force });
  await loadFromStore();
  setStatus(summaryText(summary));
}

function summaryText(s) {
  if (!s) return noDataText();
  const when = s.imported_at ? new Date(s.imported_at).toLocaleString('en-CA') : '';
  const span = s.first && s.last ? `${s.first} to ${s.last}` : '';
  return `${s.reports} reports (${span}), read ${when}; ` +
    (s.no_handle ? 'held in this browser only. Re-pick the folder to load an update.'
                 : 'held in this browser only. The folder is re-checked each visit.');
}
function noDataText() {
  return 'No FCC data is published with this site. Choose the firm\'s FCCFarmland folder ' +
    '(published by FCC-Farmland\\ingest\\run.bat). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  ui.data = (await getData()) || null;
  ui.cIdx = changeIndex(ui.data);
  ui.rIdx = regionIndex(ui.data);
  ui.$clear.hidden = !ui.data;
  setStatus(ui.data ? summaryText(await getManifest()) : noDataText());
  renderAll();
}

async function maybeAutoRefresh() {
  if (!fsAccessSupported()) return;
  const handle = await getSavedDirectory();
  if (!handle) return;
  const perm = await directoryPermission(handle);
  if (perm === 'granted') {
    const upd = await checkForUpdates(handle);
    if (upd?.changed) { try { await runImport(handle); } catch (err) { showError(err?.message || String(err)); } }
    return;
  }
  if (perm === 'prompt') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-xs underline text-accent-600 ml-1';
    btn.textContent = ui.data ? 'Check the saved folder for an update' : 'Re-open the saved folder';
    btn.addEventListener('click', async () => {
      btn.remove();
      if ((await directoryPermission(handle, { request: true })) !== 'granted') { showError('Access to the saved folder was not granted.'); return; }
      try { await runImport(handle); } catch (err) { showError(err?.message || String(err)); }
    });
    ui.$status.appendChild(btn);
  }
}

// --- Sidebar -----------------------------------------------------------------

function renderAll() {
  renderFolderBody();
  renderProvPicker();
  renderYearPickers();
  renderSectionToggles();
  renderCharts();
}

function renderFolderBody() {
  const collapsed = !!ui.data && !!ui.prefs.folderCollapsed;
  ui.$folderBody.hidden = collapsed;
  ui.$folderToggle.hidden = !ui.data;
  ui.$folderToggle.textContent = collapsed ? 'Show' : 'Hide';
  ui.$folderToggle.setAttribute('aria-expanded', String(!collapsed));
}

function selectedProv() {
  const codes = (ui.data?.provinces || []).map(p => p.code);
  if (codes.includes(ui.prefs.prov)) return ui.prefs.prov;
  const home = SGC_TO_POSTAL[getPref('province')];
  return codes.includes(home) ? home : DEFAULT_PROV;
}

function renderProvPicker() {
  ui.$prov.replaceChildren();
  for (const p of ui.data?.provinces || []) {
    const opt = document.createElement('option');
    opt.value = p.code; opt.textContent = p.code === CANADA ? 'Canada (national)' : p.name;
    ui.$prov.appendChild(opt);
  }
  ui.$prov.disabled = !ui.data;
  if (ui.data) ui.$prov.value = selectedProv();
}

function renderYearPickers() {
  const ys = [...years(ui.data)].reverse();
  ui.$year.replaceChildren();
  for (const y of ys) {
    const opt = document.createElement('option');
    opt.value = String(y); opt.textContent = String(y);
    ui.$year.appendChild(opt);
  }
  ui.$year.disabled = !ys.length;
  if (ys.length) ui.$year.value = String(ys.includes(ui.prefs.year) ? ui.prefs.year : ys[0]);
  ui.$yearFrom.value = ui.prefs.yearFrom || '';
  ui.$yearFrom.placeholder = ys.length ? String(ys[ys.length - 1]) : 'year';
  ui.$allNarr.checked = !!ui.prefs.allNarratives;
}

function enabledGroups() {
  const saved = ui.prefs.groups;
  return new Set(Array.isArray(saved) ? saved : GROUPS.map(g => g.id));
}

function setGroups(ids) {
  const next = new Set(ids);
  ui.prefs = savePrefs({ groups: GROUPS.map(g => g.id).filter(id => next.has(id)) });
  renderSectionToggles();
  renderCharts();
}

function renderSectionToggles() {
  const on = enabledGroups();
  ui.$sections.replaceChildren();
  const shown = GROUPS.filter(g => on.has(g.id)).map(g => g.label);
  ui.$sectionSummary.textContent = shown.length === GROUPS.length ? `All sections (${GROUPS.length})`
    : shown.length === 0 ? 'None selected'
    : shown.length <= 2 ? shown.join(', ')
    : `${shown.length} of ${GROUPS.length} sections`;
  for (const g of GROUPS) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = on.has(g.id);
    cb.addEventListener('change', () => {
      const next = enabledGroups();
      if (cb.checked) next.add(g.id); else next.delete(g.id);
      setGroups([...next]);
    });
    const text = document.createElement('span'); text.textContent = g.label;
    label.append(cb, text);
    ui.$sections.appendChild(label);
  }
}

function selection() {
  const ys = years(ui.data);
  const year = Number(ui.$year.value) || ys[ys.length - 1] || null;
  const from = ui.prefs.yearFrom && ui.prefs.yearFrom <= year ? ui.prefs.yearFrom : null;
  const prov = selectedProv();
  return { prov, name: provName(ui.data, prov), year, from, range: { from, to: year } };
}

const sourceFor = (year) => `${SOURCE}${year ? `, ${year}` : ''}`;

// --- Charts ------------------------------------------------------------------

function renderCharts() {
  const { $grid } = ui;
  const open = new Map();
  for (const [id, c] of ui.cards) open.set(id, readOpenPanels(c.card));
  $grid.replaceChildren();
  ui.cards.clear();
  if (!ui.data) { ui.$empty.hidden = false; ui.$about.hidden = true; return; }
  ui.$empty.hidden = true;
  ui.$about.hidden = false;

  const sel = selection();
  const on = enabledGroups();
  const drawnSections = [];
  // Retired regions (FCC's pre-2020 Ontario regions, Newfoundland's) drop off
  // once they stop reporting; their figures stay in the Excel download.
  const regs = provRegions(ui.data, ui.rIdx, sel.prov, { activeSince: sel.year - 3 });

  const lineCard = ($cards, id, { title, subtitle = '', input }) => {
    if (!input.records.length) return false;
    const card = buildIndicatorCard($cards, {
      chartId: id, fileStem: id, title, sourceLabel: sourceFor(sel.year), table: true,
      zeroBased: input.seriesMeta.every(s => s.units === 'dollar'), mirrorY: false,
      sourceInCaption: true, signed: false, captionPt: 10,
    });
    card.render(input.records, input.seriesMeta, { rangeSubtitle: 'year', subtitle, singleSeriesInSubtitle: true });
    card.setOpenPanels(open.get(id) || []);
    ui.cards.set(id, { card: card.card });
    return true;
  };

  for (const g of GROUPS) {
    if (!on.has(g.id)) continue;
    const s = document.createElement('section');
    s.className = 'cmhc-mi-section';
    s.id = `fc-section-${g.id}`;
    s.innerHTML = `<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>`;
    s.querySelector('h2').textContent = g.id === 'change' ? g.label : `${g.label} — ${sel.name}`;
    const $cards = s.querySelector('[data-role="cards"]');
    let drawn = 0;

    if (g.id === 'change') {
      const lines = [{ prov: sel.prov, label: sel.name }];
      if (sel.prov !== CANADA) lines.push({ prov: CANADA, label: 'Canada' });
      // Last 10 years unless "Charts from" says otherwise.
      const tenBack = sel.year - CHANGE_YEARS + 1;
      if (lineCard($cards, `fcc_change_${sel.prov}`, {
        title: `${sel.name} Annual % Change in Cultivated Farmland Values`,
        input: changeCardInput(`fcc_change_${sel.prov}`, ui.cIdx, lines, { from: sel.from ?? tenBack, to: sel.year }),
      })) drawn++;
      // Each region's published change (annual tables, 2017 on), capped at 10 years.
      // Pastureland the same way (published from 2022).
      if (sel.prov !== CANADA) {
        const range = { from: Math.max(sel.from ?? tenBack, tenBack), to: sel.year };
        for (const [key, list, what] of [
          ['region_change', [...regs.cultivated, ...regs.irrigated], 'Cultivated Farmland Values'],
          ['pasture_change', regs.pasture, 'Pastureland Values'],
        ]) {
          if (!list.length) continue;
          const id = `fcc_${key}_${sel.prov}`;
          if (lineCard($cards, id, {
            title: `${sel.name} Annual % Change in ${what} by Region`,
            input: regionChangeCardInput(id, ui.rIdx, list, range),
          })) drawn++;
        }
      }
      drawn += provincialTable($cards, sel);
    } else if (g.id === 'regions' && sel.prov !== CANADA) {
      for (const [key, what] of [['cultivated', 'Cultivated Farmland Value by Region'],
                                 ['irrigated', 'Irrigated Farmland Value by Region'],
                                 ['pasture', 'Pastureland Value by Region']]) {
        if (!regs[key].length) continue;
        const id = `fcc_${key}_${sel.prov}`;
        if (lineCard($cards, id, {
          title: `${sel.name} ${what}`, subtitle: 'FCC reference value, $ per acre',
          input: regionCardInput(id, ui.rIdx, regs[key], sel.range),
        })) drawn++;
      }
    } else if (g.id === 'table' && sel.prov !== CANADA) {
      drawn += regionTable($cards, sel, regs);
    } else if (g.id === 'narrative') {
      drawn += narrativeCard($cards, sel, regs);
    }
    if (drawn) { $grid.appendChild(s); drawnSections.push({ id: s.id, label: g.label }); }
  }
  if (drawnSections.length > 1) $grid.prepend(buildJumpBar(drawnSections));
  if (!$grid.childElementCount) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = 'Nothing to show for this selection.';
    $grid.appendChild(p);
  }
}

// --- Tables ------------------------------------------------------------------

/** Every province's % change, a row per year, latest first. */
function provincialTable($cards, sel) {
  const provs = (ui.data.provinces || []).map(p => p.code)
    // Newfoundland and Labrador has had no figure since 2016.
    .filter(p => changeTable(ui.cIdx, [p], { from: sel.from ?? sel.year - TABLE_YEARS + 1, to: sel.year }).some(r => r.values[0] != null));
  const rows = changeTable(ui.cIdx, provs, { from: sel.from ?? sel.year - TABLE_YEARS + 1, to: sel.year });
  if (!rows.length) return 0;
  const short = { CA: 'Canada', BC: 'B.C.', AB: 'Alta.', SK: 'Sask.', MB: 'Man.', ON: 'Ont.', QC: 'Que.', NB: 'N.B.', NS: 'N.S.', PE: 'P.E.I.', NL: 'N.L.' };
  buildTableCard($cards, {
    id: 'fcc_change_table',
    title: 'Annual % Change in Cultivated Farmland Values by Province',
    subtitle: `${rows[rows.length - 1].year}–${rows[0].year}`,
    head: ['Year', ...provs.map(p => short[p] || p)],
    rows: rows.map(r => [String(r.year), ...r.values.map(fmtPct)]),
    highlightCol: provs.indexOf(sel.prov) + 1,
    source: sourceFor(sel.year), wide: true,
  });
  return 1;
}

/** The selected year's region table: % change, $/acre and 90% value range. */
function regionTable($cards, sel, regs) {
  // One card per land type, so each exports as its own PNG; pastureland
  // tables start in 2022.
  const pastureAvg = changeIndex(ui.data, 'pasture_change');
  let drawn = 0;
  for (const [key, list, what, avg] of [
    ['regions', [...regs.cultivated, ...regs.irrigated], 'Cultivated Farmland Values', ui.cIdx],
    ['pasture', regs.pasture, 'Pastureland Values', pastureAvg],
  ]) {
    const rs = regionTableRows(ui.rIdx, list, sel.year);
    if (!rs.length) continue;
    const provPct = avg.get(sel.prov)?.get(sel.year);
    buildTableCard($cards, {
      id: `fcc_${key}_${sel.prov}_${sel.year}`,
      title: `${sel.name} ${what} by Region — ${sel.year}`,
      subtitle: `Provincial average change: ${fmtPct(provPct)}. Value range = 90% of sales (top and bottom 5% excluded)`,
      head: ['Region', '% change', 'Value $/acre', 'Value range'],
      rows: rs.map(r => [r.region.name, fmtPct(r.pct), fmtMoney(r.value), fmtRange(r.lo, r.hi)]),
      source: sourceFor(sel.year),
    });
    drawn++;
  }
  return drawn;
}

function buildTableCard(container, { id, title, subtitle, head, rows, source, wide = false, highlightCol = -1 }) {
  const card = document.createElement('section');
  card.className = `chart-card cmhc-indicator-card${wide ? ' md:col-span-2' : ''}`;
  card.dataset.chartId = id;
  const cell = (x, i) => `<td${i === highlightCol ? ' style="font-weight:600"' : ''}>${escapeHtml(String(x))}</td>`;
  const body = rows.map(r => (Array.isArray(r)
    ? `<tr>${r.map(cell).join('')}</tr>`
    : `<tr><th colspan="${head.length}" style="text-align:left">${escapeHtml(r.section)}</th></tr>`)).join('');
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot" style="max-height:none;min-height:0">
      <table class="cmhc-table cmhc-table-compact"><thead><tr>${head.map((h, i) => `<th${i === highlightCol ? ' style="font-weight:700"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table>
    </div>
    <div class="chart-caption chart-caption-sourced"><span class="chart-source" data-role="source"></span></div>
    <div class="chart-actions">
      <button type="button" data-role="copy">Copy table</button>
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  container.appendChild(card);
  const $source = card.querySelector('[data-role="source"]');
  $source.textContent = `Source: ${source}`;
  // 12 pt table text and a 10 pt caption in the 1950 px PNG, cropped to the
  // table, shrinking only if a long table will not fit (as on Rentals.ca).
  const CAPTION_IMAGE_PX = (10 / 72) * EXPORT_DPI;
  const TABLE_IMAGE_PX = (12 / 72) * EXPORT_DPI;
  const $scroll = card.querySelector('[data-role="plot"]');
  const $table = $scroll.querySelector('table');
  const $cells = [...$table.querySelectorAll('th, td')];
  const setTable = (px) => {
    $table.style.setProperty('font-size', `${px.toFixed(2)}px`);
    for (const c of $cells) {
      c.style.setProperty('padding', `${(px * 0.2).toFixed(2)}px ${(px * 0.5).toFixed(2)}px`);
      c.style.setProperty('line-height', '1.15');
    }
  };
  const fit = () => {
    const sW = EXPORT_W / card.offsetWidth;
    $source.style.setProperty('font-size', `${(CAPTION_IMAGE_PX / sW).toFixed(2)}px`, 'important');
    let px = TABLE_IMAGE_PX / sW;
    setTable(px);
    for (let i = 0; i < 8; i++) {
      const over = Math.max((card.offsetHeight * (EXPORT_W / card.offsetWidth)) / EXPORT_H,
        $table.scrollWidth / Math.max(1, $scroll.clientWidth));
      if (over <= 1.005) break;
      px = (px / over) * 0.98;
      setTable(px);
    }
  };
  setExportCropHeight(card);
  setExportRedraw(card, (h) => {
    if (h == null) {
      $source.style.removeProperty('font-size');
      $scroll.style.removeProperty('overflow');
      $table.style.removeProperty('font-size');
      for (const c of $cells) { c.style.removeProperty('padding'); c.style.removeProperty('line-height'); }
      return;
    }
    $scroll.style.setProperty('overflow', 'visible');
    fit();
  });
  const tsv = [head, ...rows.map(r => (Array.isArray(r) ? r : [r.section]))].map(r => r.join('\t')).join('\n');
  const $copy = card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[fcc png]', err));
  ui.cards.set(id, { card });
}

// --- Narrative ---------------------------------------------------------------

/** "Farm Credit Canada, 2025 Farmland Values Report" from the PDF file name(s). */
const reportName = (files) => files.split('; ')
  .map(f => `Farm Credit Canada, ${f.replace(/\.pdf$/i, '').replace(/^Farm Credit Canada - /, '').replace(/ _ FCC$/, '')}`)
  .join('; ');

/**
 * The report's own words on the province for the selected year (annual report
 * plus any mid-year update), or every year when "all years" is ticked. Region
 * names are bolded so the drivers for each region are easy to find.
 */
function narrativeCard($cards, sel, regs) {
  const all = narrativesFor(ui.data, sel.prov);
  const list = ui.prefs.allNarratives ? all.filter(n => !sel.from || n.year >= sel.from).filter(n => n.year <= sel.year)
    : all.filter(n => n.year === sel.year);
  const card = document.createElement('section');
  card.className = 'chart-card md:col-span-2';
  card.dataset.chartId = `fcc_narrative_${sel.prov}`;
  const head = document.createElement('header');
  head.className = 'chart-title';
  head.textContent = `${sel.name} — What FCC Said${ui.prefs.allNarratives ? '' : `, ${sel.year}`}`;
  const sub = document.createElement('p');
  sub.className = 'chart-sub';
  const avail = narrativeYears(ui.data, sel.prov);
  sub.textContent = list.length
    ? 'Drivers by region, in the report\'s own words. Region names in bold.'
    : `No narrative for ${sel.year}. Years with one: ${avail.slice(0, 12).join(', ')}${avail.length > 12 ? '…' : ''}.`;
  card.append(head, sub);
  const names = [...regs.cultivated, ...regs.irrigated, ...regs.pasture].map(r => r.name)
    .concat((ui.data.regions || []).filter(r => r.prov === sel.prov).map(r => r.name));
  const body = document.createElement('div');
  body.className = 'space-y-4 text-sm text-neutral-800 max-w-4xl';
  for (const n of list) {
    const block = document.createElement('article');
    const h = document.createElement('h3');
    h.className = 'font-semibold text-neutral-700 mb-1';
    h.textContent = periodLabel(n.year, n.period);
    block.appendChild(h);
    for (const para of n.paras) {
      const p = document.createElement('p');
      p.className = 'mb-2 leading-relaxed';
      for (const run of markRegions(para, names)) {
        if (run.region) { const b = document.createElement('strong'); b.textContent = run.text; p.appendChild(b); }
        else p.appendChild(document.createTextNode(run.text));
      }
      block.appendChild(p);
    }
    const src = document.createElement('p');
    src.className = 'text-xs text-neutral-500';
    src.textContent = `Source: ${reportName(n.report)}`;
    block.appendChild(src);
    body.appendChild(block);
  }
  card.appendChild(body);
  if (list.length) {
    const actions = document.createElement('div');
    actions.className = 'chart-actions';
    const $copy = document.createElement('button');
    $copy.type = 'button'; $copy.textContent = 'Copy text';
    $copy.addEventListener('click', async () => {
      const text = list.map(n => [periodLabel(n.year, n.period), ...n.paras,
        `Source: ${reportName(n.report)}`].join('\n\n')).join('\n\n');
      try { await navigator.clipboard.writeText(text); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy text'; }, 1500); }
      catch { $copy.textContent = 'Copy failed'; }
    });
    actions.appendChild($copy);
    card.appendChild(actions);
  }
  $cards.appendChild(card);
  return 1;
}

// --- Excel (data) ----------------------------------------------------------------

async function exportData() {
  if (!ui.data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const d = ui.data;
  const pName = Object.fromEntries((d.provinces || []).map(p => [p.code, p.name]));
  const regionById = new Map((d.regions || []).map(r => [r.id, r]));

  const ws1 = wb.addWorksheet('Provincial % change');
  ws1.addRow([`${SOURCE} — annual % change in cultivated farmland values`]).font = { bold: true };
  ws1.addRow([]);
  const provs = (d.provinces || []).map(p => p.code);
  ws1.addRow(['Year', ...provs.map(p => pName[p])]).font = { bold: true };
  for (const r of changeTable(ui.cIdx, provs).reverse()) ws1.addRow([r.year, ...r.values.map(v => (v == null ? null : v / 100))]);
  ws1.getColumn(1).width = 8;
  for (let i = 2; i <= provs.length + 1; i++) { ws1.getColumn(i).width = 12; ws1.getColumn(i).numFmt = '0.0%'; }

  const pIdx = changeIndex(d, 'pasture_change');
  const pProvs = provs.filter(p => pIdx.has(p));
  if (pProvs.length) {
    const wsP = wb.addWorksheet('Pastureland % change');
    wsP.addRow([`${SOURCE} — provincial average % change in pastureland values`]).font = { bold: true };
    wsP.addRow([]);
    wsP.addRow(['Year', ...pProvs.map(p => pName[p])]).font = { bold: true };
    for (const r of changeTable(pIdx, pProvs).reverse()) wsP.addRow([r.year, ...r.values.map(v => (v == null ? null : v / 100))]);
    wsP.getColumn(1).width = 8;
    for (let i = 2; i <= pProvs.length + 1; i++) { wsP.getColumn(i).width = 16; wsP.getColumn(i).numFmt = '0.0%'; }
  }

  const ws2 = wb.addWorksheet('Regions');
  ws2.addRow(['FCC reference value $/acre by region. "Value" is FCC\'s restated series (Historic report); "As published" is the figure printed in that year\'s report; % change and the 90% value range are from that year\'s report.']);
  ws2.addRow([]);
  ws2.addRow(['Year', 'Province', 'Land', 'Region', 'Value $/acre', 'As published $/acre', '% change', 'Range low', 'Range high']).font = { bold: true };
  const obs = [...(d.region_obs || [])].sort((a, b) => {
    const ra = regionById.get(a[1]); const rb = regionById.get(b[1]);
    return (ra?.prov || '').localeCompare(rb?.prov || '') || (ra?.land || '').localeCompare(rb?.land || '')
      || (ra?.name || '').localeCompare(rb?.name || '') || a[0] - b[0];
  });
  for (const [year, id, value, pct, lo, hi, pub] of obs) {
    const r = regionById.get(id);
    ws2.addRow([year, pName[r?.prov] || r?.prov, LAND_LABEL[r?.land] || r?.land, r?.name, value, pub, pct == null ? null : pct / 100, lo, hi]);
  }
  [8, 22, 16, 44, 14, 18, 10, 12, 12].forEach((w, i) => { ws2.getColumn(i + 1).width = w; });
  for (const c of [5, 6, 8, 9]) ws2.getColumn(c).numFmt = '$#,##0';
  ws2.getColumn(7).numFmt = '0.0%';

  const ws3 = wb.addWorksheet('Narratives');
  ws3.addRow(['Year', 'Report', 'Province', 'Narrative', 'Source file']).font = { bold: true };
  for (const n of d.narratives || []) {
    const row = ws3.addRow([n.year, periodLabel(n.year, n.period), pName[n.prov] || n.prov, n.paras.join('\n\n'), n.report]);
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
  }
  [8, 40, 22, 120, 50].forEach((w, i) => { ws3.getColumn(i + 1).width = w; });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `FCC_Farmland_Values_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

