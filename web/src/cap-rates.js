/*
 * Cap Rates tab — Winnipeg capitalization-rate ranges by property type and
 * class, as published quarterly by Colliers, CBRE and Cushman & Wakefield
 * and compiled in the firm's Cap Rate Tables workbook.
 *
 * NO CAP-RATE DATA SHIPS WITH THE SITE. The workbook's quarterly sheets are
 * parsed by Cap-Rates/ingest/parse_cap_rates.py into cap_rates.json and
 * published to SharedInfo\AppMarketData\AppMarketData-External\CapRates; the user nominates that folder
 * here and the browser reads it locally (cap-rates-store.js).
 *
 * Per property type: average cap rate by class, one class by firm, that
 * class's range (band), and the selected quarter's table in the workbook's
 * layout. The quarter picker sets both the table's quarter and the end of
 * the charts, so any past quarter can be reproduced.
 */

import { buildIndicatorCard, readOpenPanels } from './indicator-chart.js';
import { downloadCardPng, setExportRedraw, setExportCropHeight, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';
import { escapeHtml } from './escape.js';
import { getPref, setPref } from './prefs.js';
import { buildJumpBar } from './jump-bar.js';
import {
  TYPE_ORDER, FIRM_ORDER, quarterList, typesPresent, rowsUpTo, splitOfficeByLocation,
  officeTotalsTable, officeByClassTable,
  averageByFirm, combineTypes, quarterTable, toCardInput, fmtRate, defaultYearFrom, firmLabel, carriedNote,
} from './cap-rates-data.js';
import {
  storeAvailable, fsAccessSupported, pickDirectory, getSavedDirectory, directoryPermission,
  importFromDirectory, importFromFileList, checkForUpdates, getData, getManifest, clearCapRates,
} from './cap-rates-store.js';
import { onSourcesUpdated } from './market-data-channel.js';

const PREF_KEY = 'capRates.v1';
const SOURCE = 'Colliers, CBRE & Cushman & Wakefield Quarterly Cap Rate Market Reports';
// One line per brokerage, in each brokerage's brand hue: Colliers blue,
// CBRE green, Cushman & Wakefield red. Colliers' navy reads as black at
// line weight, so its brighter brand blue is used; CBRE's green is lifted a
// step for the same reason. The three sit far apart in hue and lightness.
const FIRM_COLOURS = { Colliers: '#0057B8', CBRE: '#00A651', 'Cushman & Wakefield': '#E4002B' };

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

export async function initCapRates() {
  const $status = document.getElementById('cr-folder-status');
  const $grid = document.getElementById('cr-chart-grid');
  if (!$status || !$grid) return;
  ui = {
    $status, $grid,
    $error: document.getElementById('cr-folder-error'),
    $pick: document.getElementById('cr-pick-folder'),
    $pickFallback: document.getElementById('cr-pick-fallback'),
    $rescan: document.getElementById('cr-rescan'),
    $clear: document.getElementById('cr-clear'),
    $quarter: document.getElementById('cr-quarter'),
    $types: document.getElementById('cr-type-toggles'),
    $typeMenu: document.getElementById('cr-type-menu'),
    $typeSummary: document.getElementById('cr-type-summary-text'),
    $folderToggle: document.getElementById('cr-folder-toggle'),
    $folderBody: document.getElementById('cr-folder-body'),
    $jump: document.getElementById('cr-jump-list'),
    $yearFrom: document.getElementById('cr-year-from'),
    $xlsx: document.getElementById('cr-download-xlsx'),
    $empty: document.getElementById('cr-empty'),
    data: null,
    cards: new Map(),
    prefs: loadPrefs(),
  };
  if (!storeAvailable()) {
    showError('This browser cannot store the cap-rate data locally (IndexedDB is unavailable).');
    return;
  }
  wireControls();
  await loadFromStore();
  // Refill when the Local Data strip loads this tab from AppMarketData.
  onSourcesUpdated(['caprates'], async () => { await loadFromStore(); await maybeAutoRefresh(); });
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
      if (!handle) { showError('No folder is saved yet — choose the CapRates folder first.'); return; }
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
    await clearCapRates();
    ui.data = null;
    renderAll();
    setStatus(noDataText());
    $clear.hidden = true;
  });
  // Once data is loaded the folder controls are rarely needed: the status line
  // stays visible and the buttons + help fold away (remembered per browser).
  ui.$folderToggle.addEventListener('click', () => {
    ui.prefs = savePrefs({ folderCollapsed: !ui.prefs.folderCollapsed });
    renderFolderBody();
  });
  // Property-type dropdown: All / None, and close on an outside click or Esc.
  document.getElementById('cr-type-all').addEventListener('click', () => setTypes(typesPresent(ui.data?.rows || [])));
  document.getElementById('cr-type-none').addEventListener('click', () => setTypes([]));
  document.addEventListener('click', (e) => { if (ui.$typeMenu.open && !ui.$typeMenu.contains(e.target)) ui.$typeMenu.open = false; });
  ui.$typeMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ui.$typeMenu.open = false; ui.$typeMenu.querySelector('summary').focus(); } });
  ui.$quarter.addEventListener('change', () => { ui.prefs = savePrefs({ quarter: ui.$quarter.value }); renderCharts(); });
  ui.$yearFrom.addEventListener('change', () => { ui.prefs = savePrefs({ yearFrom: ui.$yearFrom.value || null }); renderCharts(); });
  ui.$xlsx?.addEventListener('click', () => exportData().catch(err => {
    console.error('[cap-rates excel]', err);
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
  return `${s.quarters} quarters (${s.first} to ${s.last}), ${s.rows} rows, read ${when}. ` +
    (s.no_handle ? 'Held in this browser only; re-pick the folder to load an update.'
                 : 'Held in this browser only; the folder is re-checked each visit.');
}
function noDataText() {
  return 'No cap-rate data is published with this site. Choose the firm\'s CapRates folder ' +
    '(published by Cap-Rates\\ingest\\run.bat). The data stays in this browser — it is not uploaded.';
}

async function loadFromStore() {
  const data = (await getData()) || null;
  // Downtown and Suburban Office as two types, each with its own chart and
  // table (splitOfficeByLocation); the stored rows are left as they are.
  ui.data = data ? { ...data, rows: splitOfficeByLocation(data.rows || []) } : null;
  ui.$clear.hidden = !ui.data;
  setStatus(ui.data ? summaryText(await getManifest()) : noDataText());
  renderAll();
  // Cap vs Interest on the Market Indicators tab draws from the same store;
  // tell it the data changed so it re-reads without a page reload.
  window.dispatchEvent(new CustomEvent('hed:cap-rates-updated'));
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
  renderQuarterPicker();
  renderTypeToggles();
  renderCharts();
}

function renderQuarterPicker() {
  const $sel = ui.$quarter;
  $sel.replaceChildren();
  const qs = ui.data ? quarterList(ui.data).reverse() : [];
  for (const q of qs) {
    const opt = document.createElement('option');
    opt.value = q; opt.textContent = q;
    $sel.appendChild(opt);
  }
  if (ui.prefs.quarter && qs.includes(ui.prefs.quarter)) $sel.value = ui.prefs.quarter;
  else if (qs.length) $sel.value = qs[0];
  $sel.disabled = qs.length === 0;
  // The rolling default shows as the placeholder, so a blank box still says what it means.
  ui.$yearFrom.value = ui.prefs.yearFrom || '';
  const dflt = ui.data ? defaultYearFrom(quarterList(ui.data)) : null;
  ui.$yearFrom.placeholder = dflt ? String(dflt) : 'year';
}

function enabledTypes() {
  const saved = ui.prefs.types;
  const on = new Set(Array.isArray(saved) ? saved : TYPE_ORDER);
  // A choice saved before Office was split: "Office" means both halves. Only
  // for such a save — TYPE_ORDER still lists the plain "Office" type, so
  // expanding it unconditionally re-ticked both halves on every untick.
  if (Array.isArray(saved) && !ui.prefs.officeSplit && on.has('Office')) {
    on.add('Downtown Office'); on.add('Suburban Office');
  }
  return on;
}

function renderFolderBody() {
  // With no data the folder controls are the only way in, so never hide them.
  const collapsed = !!ui.data && !!ui.prefs.folderCollapsed;
  ui.$folderBody.hidden = collapsed;
  ui.$folderToggle.hidden = !ui.data;
  ui.$folderToggle.textContent = collapsed ? 'Show' : 'Hide';
  ui.$folderToggle.setAttribute('aria-expanded', String(!collapsed));
}

/** Save a new set of ticked types (keeps TYPE_ORDER first) and redraw. */
function setTypes(list) {
  const types = ui.data ? typesPresent(ui.data.rows) : [];
  const next = new Set(list);
  ui.prefs = savePrefs({ officeSplit: true, types: [...TYPE_ORDER, ...types].filter((x, i, a) => a.indexOf(x) === i && next.has(x)) });
  renderTypeToggles();
  renderCharts();
}

function renderTypeToggles() {
  const types = ui.data ? typesPresent(ui.data.rows) : [];
  const on = enabledTypes();
  ui.$types.replaceChildren();
  ui.$jump.replaceChildren();
  const shown = types.filter(t => on.has(t));
  ui.$typeSummary.textContent = !types.length ? 'No data'
    : shown.length === types.length ? `All types (${types.length})`
    : shown.length === 0 ? 'None selected'
    : shown.length <= 2 ? shown.join(', ')
    : `${shown.length} of ${types.length} types`;
  const jumpLink = (text, id) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${id}`; a.className = 'underline text-accent-600'; a.textContent = text;
    a.addEventListener('click', (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    li.appendChild(a); ui.$jump.appendChild(li);
  };
  let officeLinked = false;
  for (const t of types) {
    // The overall Office section sits above Downtown / Suburban Office.
    if ((t === 'Downtown Office' || t === 'Suburban Office') && !officeLinked) {
      officeLinked = true;
      jumpLink('Office', 'cr-section-office-all');
    }
    const label = document.createElement('label');
    label.className = 'flex items-center gap-1 text-sm cursor-pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = on.has(t);
    cb.addEventListener('change', () => {
      const next = enabledTypes();
      if (cb.checked) next.add(t); else next.delete(t);
      setTypes([...next]);
    });
    const text = document.createElement('span'); text.textContent = t;
    label.append(cb, text);
    ui.$types.appendChild(label);
    jumpLink(t, `cr-section-${slug(t)}`);
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

// --- Charts ------------------------------------------------------------------

/** The chart start: the user's year if set, else Q1 five years before the latest quarter. */
function yearFrom() {
  if (ui.prefs.yearFrom) return Number(ui.prefs.yearFrom);
  return ui.data ? defaultYearFrom(quarterList(ui.data)) : null;
}

function selection() {
  const quarter = ui.$quarter.value || null;
  const rows = rowsUpTo(ui.data?.rows || [], quarter);
  const yf = yearFrom();
  const monthFrom = yf ? `${yf}-01` : null;
  return { quarter, rows, monthFrom };
}

function renderCharts() {
  const { $grid } = ui;
  const open = new Map();
  for (const [id, c] of ui.cards) open.set(id, readOpenPanels(c.card));
  $grid.replaceChildren();
  ui.cards.clear();
  if (!ui.data) { ui.$empty.hidden = false; return; }
  ui.$empty.hidden = true;

  const { quarter, rows, monthFrom } = selection();
  const on = enabledTypes();
  const drawnSections = [];

  // An overall Office section (chart + the two combined tables) goes just
  // before the first Downtown / Suburban office section, i.e. after Retail
  // (Jason, 2026-10-21).
  const OFFICE_TYPES = ['Downtown Office', 'Suburban Office'];
  let officeDrawn = false;

  const newSection = (id, heading) => {
    const section = document.createElement('section');
    section.className = 'cmhc-mi-section';
    section.id = id;
    section.innerHTML = `<h2 class="cmhc-mi-section-title"></h2><div class="grid md:grid-cols-2 gap-4 items-start" data-role="cards"></div>`;
    section.querySelector('h2').textContent = heading;
    return [section, section.querySelector('[data-role="cards"]')];
  };
  // Overall average by firm: the Excel chart, one line per brokerage, each
  // the mean of its published class mid-points that quarter.
  const firmsChart = ($cards, id, label, points, description) => {
    const input = toCardInput(id, points, { lineOrder: FIRM_ORDER });
    const card = buildIndicatorCard($cards, {
      chartId: id, fileStem: id, title: `Winnipeg ${label} Cap Rates`, sourceLabel: SOURCE, table: true, zeroBased: true,
      // "Source: …" alone, bottom-right of the caption and out of the
      // subtitle; no company name on any Cap Rates figure — they reproduce
      // the brokerages' published figures (Jason, 2026-09-30). 10 pt in print.
      sourceInCaption: true, signed: false, captionPt: 10,
      // Left-hand y axis only — no mirrored labels on the right.
      mirrorY: false,
      description: description + ' ' + note(),
    });
    // The subtitle is just the range, "March 2021 to June 2026" (in the
    // title it ran too long for a December end); the caption names the
    // brokerages (Jason, 2026-09-30).
    card.render(input.records, input.seriesMeta, {
      rangeSubtitle: 'month', monthFrom,
      seriesColours: Object.fromEntries(input.seriesMeta.map(m => [m.id, FIRM_COLOURS[m.chartLabel]]).filter(([, c]) => c)),
    });
    card.setOpenPanels(open.get(id) || []);
    ui.cards.set(id, { card: card.card });
  };
  const tableCard = ($cards, id, title, subtitle, table) => {
    const card = buildTableCard($cards, { id, title, subtitle, table, quarter });
    ui.cards.set(id, { card: card.card });
  };

  for (const type of typesPresent(rows)) {
    if (!on.has(type)) continue;

    if (OFFICE_TYPES.includes(type) && !officeDrawn) {
      officeDrawn = true;
      const [section, $cards] = newSection('cr-section-office-all', 'Office');
      firmsChart($cards, 'caprate_office_firms', 'Office', averageByFirm(combineTypes(rows, OFFICE_TYPES, 'Office'), 'Office'),
        'Each brokerage’s overall office cap rate: the mean of the mid-points of every downtown and suburban class it publishes that quarter.');
      // Every office cap rate in one table, a Downtown and a Suburban column
      // pair (Jason, 2026-09-30)…
      const office = officeTotalsTable(rows, quarter);
      if (office) {
        tableCard($cards, 'caprate_office_table', `Winnipeg Office Cap Rates — ${quarter}`,
          'Downtown and Suburban: average of each brokerage’s published class ranges', office);
      }
      // …and the same by class: the workbook's office table, Downtown and
      // Suburban over Class A / Class B over Low / High.
      const officeClasses = officeByClassTable(rows, quarter);
      if (officeClasses) {
        tableCard($cards, 'caprate_office_classes_table', `Winnipeg Office Cap Rates by Class — ${quarter}`,
          'Downtown and Suburban: published Low–High range by brokerage and class', officeClasses);
      }
      $grid.appendChild(section);
      drawnSections.push({ id: section.id, label: 'Office' });
    }

    const [section, $cards] = newSection(`cr-section-${slug(type)}`, type);
    firmsChart($cards, `caprate_${slug(type)}_firms`, type, averageByFirm(rows, type),
      `Each brokerage's overall ${type.toLowerCase()} cap rate: the mean of the mid-points of every class it publishes for the type that quarter.`);
    // The quarter's table, a Low / High pair per class. Downtown and Suburban
    // office too: by class, not one all-class range (Jason, 2026-10-21 — the
    // totals live on in the Office section's table).
    tableCard($cards, `caprate_${slug(type)}_table`, `Winnipeg ${type} Cap Rates — ${quarter}`,
      'Published Low–High range by brokerage', quarterTable(rows, type, quarter));
    $grid.appendChild(section);
    drawnSections.push({ id: section.id, label: type });
  }
  if (drawnSections.length > 1) $grid.prepend(buildJumpBar(drawnSections));
  if (!$grid.childElementCount) {
    const p = document.createElement('p');
    p.className = 'text-sm text-neutral-600';
    p.textContent = 'No property types selected.';
    $grid.appendChild(p);
  }
}

function note() {
  return 'Rates are the brokerages’ published survey ranges, read from a file on your computer and not published with this site. ' +
    'Quarters before the workbook’s first quarterly sheet come from its Summary sheet, whose retail and multi-family classes are grouped differently, so those class names change at the join.';
}

// --- Quarter table card ------------------------------------------------------

function buildTableCard(container, { id, title, subtitle, table, quarter }) {
  const card = document.createElement('section');
  card.className = 'chart-card cmhc-indicator-card';
  card.dataset.chartId = id;
  const { subtypes, firms, cells, average, groups } = table;
  const label = (s) => table.labels?.[s] ?? s;
  // A grouped table (office by class) has a third header row on top:
  // Downtown / Suburban over the classes.
  const head0 = groups ? groups.map(g => `<th colspan="${2 * g.span}">${escapeHtml(g.label)}</th>`).join('') : '';
  const head1 = subtypes.map(s => `<th colspan="2">${escapeHtml(label(s))}</th>`).join('');
  const head2 = subtypes.map(() => '<th>Low</th><th>High</th>').join('');
  const thead = groups
    ? `<tr><th rowspan="3">Source</th>${head0}</tr><tr>${head1}</tr><tr>${head2}</tr>`
    : `<tr><th rowspan="2">Source</th>${head1}</tr><tr>${head2}</tr>`;
  const body = firms.map(f => `<tr><td>${escapeHtml(firmLabel(table, f))}</td>${subtypes.map(s => {
    const c = cells[f]?.[s];
    return `<td>${fmtRate(c?.low)}</td><td>${fmtRate(c?.high)}</td>`;
  }).join('')}</tr>`).join('');
  const avg = `<tr class="font-semibold cr-avg-row"><td>Average</td>${subtypes.map(s => `<td>${fmtRate(average[s]?.low)}</td><td>${fmtRate(average[s]?.high)}</td>`).join('')}</tr>`;
  // A late report's previous-quarter figures, marked "*" on the name.
  const footnote = carriedNote(table, quarter);
  const foot = body && footnote
    ? `<tfoot><tr class="cr-footnote"><td colspan="${1 + 2 * subtypes.length}">${escapeHtml(footnote)}</td></tr></tfoot>`
    : '';
  card.innerHTML = `
    <header class="chart-title">${escapeHtml(title)}</header>
    <p class="chart-sub">${escapeHtml(subtitle)}</p>
    <div class="cmhc-chart-table-scroll" data-role="plot">
      <table class="cmhc-table cmhc-table-compact"><thead>${thead}</thead>
      <tbody>${body || '<tr><td colspan="99">No figures for this quarter.</td></tr>'}${body ? avg : ''}</tbody>${foot}</table>
    </div>
    <div class="chart-caption chart-caption-sourced"><span class="chart-source" data-role="source"></span></div>
    <div class="chart-actions">
      <button type="button" data-role="copy">Copy table</button>
      <button type="button" data-role="dl-png">Download PNG</button>
    </div>`;
  container.appendChild(card);
  // "Source: …" bottom-right. No company name: the tables reproduce the
  // brokerages' published figures, so only the source signs them (Jason,
  // 2026-09-30) — as on this tab's trend charts (signed: false).
  const $source = card.querySelector('[data-role="source"]');
  $source.textContent = `Source: ${SOURCE}`;
  // In the exported image the caption prints at exactly 10 pt. The PNG is
  // 1950 px across 6.5 in (300 DPI), so 10 pt is 10/72 × 300 ≈ 41.7 image px;
  // the card is laid out at the standard 750 px export width (png-export's
  // redraw hook) and scaled to fit, so the CSS size is that over the scale,
  // measured twice because the caption's own size moves the card's height.
  // The table text prints at 12 pt the same way, in compact rows at their
  // natural height (Jason, 2026-10-02: no longer stretched to fill the frame).
  const CAPTION_IMAGE_PX = (10 / 72) * EXPORT_DPI;
  const TABLE_IMAGE_PX = (12 / 72) * EXPORT_DPI;
  const $scroll = card.querySelector('[data-role="plot"]');
  const $table = $scroll.querySelector('table');
  const $cells = [...$table.querySelectorAll('th, td')];
  // Brokerage names stay on one line ("Cushman & Wakefield", not three).
  const $names = [...$table.querySelectorAll('tbody td:first-child')];
  // The footnote spans the table and wraps rather than widening it.
  const $foot = $table.querySelector('.cr-footnote td');
  if ($foot) $foot.style.setProperty('white-space', 'normal');
  for (const c of $names) c.style.setProperty('white-space', 'nowrap');
  const setTable = (px, padX = 0.5) => {
    $table.style.setProperty('font-size', `${px.toFixed(2)}px`);
    // Tight rows: a fifth of the text size above and below, line height 1.15.
    for (const c of $cells) {
      c.style.setProperty('padding', `${(px * 0.2).toFixed(2)}px ${(px * padX).toFixed(2)}px`);
      c.style.setProperty('line-height', '1.15');
    }
  };
  // 12 pt at the card's scale; a table with many classes (Retail) is wider
  // than the frame at that size and would be cut off at the card's edge, so
  // first narrow the cells' side padding, then shrink the text until it fits.
  const fit = () => {
    const scale = Math.min(EXPORT_W / card.offsetWidth, EXPORT_H / card.offsetHeight);
    $source.style.setProperty('font-size', `${(CAPTION_IMAGE_PX / scale).toFixed(2)}px`, 'important');
    let px = TABLE_IMAGE_PX / scale;
    let padX = 0.5;
    setTable(px, padX);
    if ($table.scrollWidth > $scroll.clientWidth * 1.005) { padX = 0.2; setTable(px, padX); }
    for (let i = 0; i < 8; i++) {
      const over = $table.scrollWidth / Math.max(1, $scroll.clientWidth);
      if (over <= 1.005) break;
      px = (px / over) * 0.98;
      setTable(px, padX);
    }
  };
  // The 12 pt table is shorter than the 1050 px frame: crop the PNG to it
  // rather than centring it between bands of white (Jason, 2026-10-02).
  setExportCropHeight(card);
  // On screen too, a table wider than its card shrinks to fit rather than
  // scrolling sideways (Jason, 2026-10-16): narrower side padding first, then
  // smaller text, down to a 9 px floor (below that the scrollbar returns).
  const clearTable = () => {
    $table.style.removeProperty('font-size');
    for (const c of $cells) { c.style.removeProperty('padding'); c.style.removeProperty('line-height'); }
  };
  const fitScreen = () => {
    if (card.classList.contains('cmhc-exporting') || !$scroll.clientWidth) return;
    clearTable();
    if ($table.scrollWidth <= $scroll.clientWidth) return;
    let px = parseFloat(getComputedStyle($table).fontSize);
    const padY = getComputedStyle($cells[0]).paddingTop;
    const setScreen = (fs) => {
      $table.style.setProperty('font-size', `${fs.toFixed(2)}px`);
      for (const c of $cells) c.style.setProperty('padding', `${padY} ${(fs * 0.3).toFixed(2)}px`);
    };
    setScreen(px);
    for (let i = 0; i < 8; i++) {
      const over = $table.scrollWidth / $scroll.clientWidth;
      if (over <= 1.005 || px <= 9) break;
      px = Math.max(9, (px / over) * 0.98);
      setScreen(px);
    }
  };
  new ResizeObserver(() => fitScreen()).observe($scroll);
  setExportRedraw(card, (h) => {
    if (h == null) {
      $source.style.removeProperty('font-size');
      $scroll.style.removeProperty('overflow');
      clearTable();
      fitScreen();
      return;
    }
    $scroll.style.setProperty('overflow', 'visible');
    // The sizes move the card's height, which moves the scale: settle it.
    fit(); fit(); fit();
  });
  const tsv = [
    ['Source', ...subtypes.flatMap(s => [`${s} Low`, `${s} High`])].join('\t'),
    ...firms.map(f => [firmLabel(table, f), ...subtypes.flatMap(s => [fmtRate(cells[f]?.[s]?.low), fmtRate(cells[f]?.[s]?.high)])].join('\t')),
    ['Average', ...subtypes.flatMap(s => [fmtRate(average[s]?.low), fmtRate(average[s]?.high)])].join('\t'),
    ...(footnote ? [footnote] : []),
  ].join('\n');
  const $copy = card.querySelector('[data-role="copy"]');
  $copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tsv); $copy.textContent = 'Copied'; setTimeout(() => { $copy.textContent = 'Copy table'; }, 1500); }
    catch { $copy.textContent = 'Copy failed'; }
  });
  card.querySelector('[data-role="dl-png"]').onclick = () => downloadCardPng(card, `${id}_${new Date().toISOString().slice(0, 10)}.png`, {
    filter: (n) => !(n.classList && n.classList.contains('chart-actions')),
  }).catch(err => console.error('[cap-rates png]', err));
  return { card };
}

// --- Excel (data) ------------------------------------------------------------

async function exportData() {
  if (!ui.data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const { quarter, rows } = selection();
  const on = enabledTypes();

  const sheets = [];
  let officeDone = false;
  for (const type of typesPresent(rows)) {
    if (!on.has(type)) continue;
    // The combined Office sheets come first, as the Office section does on
    // the page.
    if ((type === 'Downtown Office' || type === 'Suburban Office') && !officeDone) {
      officeDone = true;
      const office = officeTotalsTable(rows, quarter);
      if (office) sheets.push(['Office', office]);
      const officeClasses = officeByClassTable(rows, quarter);
      if (officeClasses) sheets.push(['Office by class', officeClasses, `Winnipeg Office Cap Rates by Class — ${quarter}`]);
    }
    sheets.push([type, quarterTable(rows, type, quarter)]);
  }
  // Excel percentages: store the fraction (0.065) and format it as 6.50%.
  // The tables hold percent units (6.5), the raw rows fractions (0.065).
  const PCT = '0.00%';
  const frac = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e6);
  const raw = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6);
  const fmtPct = (row, from) => row.eachCell((c, i) => { if (i >= from && typeof c.value === 'number') c.numFmt = PCT; });
  for (const [type, t, title = `Winnipeg ${type} Cap Rates — ${quarter}`] of sheets) {
    const ws = wb.addWorksheet(`${type} ${quarter}`.slice(0, 31));
    ws.addRow([title]).font = { bold: true };
    ws.addRow([`Source: ${SOURCE}`]);
    ws.addRow([]);
    if (t.groups) {
      ws.addRow(['', ...t.groups.flatMap(g => [g.label, ...Array(2 * g.span - 1).fill('')])]).font = { bold: true };
    }
    ws.addRow(['Source', ...t.subtypes.flatMap(s => [t.labels?.[s] ?? s, ''])]).font = { bold: true };
    ws.addRow(['', ...t.subtypes.flatMap(() => ['Low', 'High'])]).font = { bold: true };
    for (const f of t.firms) fmtPct(ws.addRow([firmLabel(t, f), ...t.subtypes.flatMap(s => [frac(t.cells[f]?.[s]?.low), frac(t.cells[f]?.[s]?.high)])]), 2);
    const avgRow = ws.addRow(['Average', ...t.subtypes.flatMap(s => [frac(t.average[s]?.low), frac(t.average[s]?.high)])]);
    avgRow.font = { bold: true }; fmtPct(avgRow, 2);
    const footnote = carriedNote(t, quarter);
    if (footnote) ws.addRow([footnote]).font = { italic: true };
    ws.getColumn(1).width = 22;
  }
  const all = wb.addWorksheet('All rows');
  all.addRow(['Quarter', 'Date', 'Market', 'Firm', 'Type', 'Class', 'Low', 'High', 'Mid']).font = { bold: true };
  // orderBy() sorts strings, not row objects — sort the rows directly.
  const byText = (x, y) => String(x ?? '').localeCompare(String(y ?? ''));
  for (const r of [...rows].sort((a, b) => byText(a.date, b.date) || byText(a.type, b.type) || byText(a.firm, b.firm) || byText(a.subtype, b.subtype))) {
    fmtPct(all.addRow([r.quarter, r.date, r.market, r.firm, r.type, r.subtype, raw(r.low), raw(r.high), raw(r.mid)]), 7);
  }
  [12, 12, 12, 22, 14, 24, 8, 8, 8].forEach((w, i) => { all.getColumn(i + 1).width = w; });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `CapRates_${quarter.replace(' ', '')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
