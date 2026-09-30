/*
 * resultsTable.js — the results grid: row selection, sortable headers,
 * paging, count line, and the export toolbar (CSV, XLSX, copy for Word).
 * Receives the filtered rows from main.js; owns sort, page and
 * selection state.
 *
 * Selection is a Set of listing ids that survives filter changes, so a
 * comp set can be picked across several searches; "Selected only" views
 * it, and the export scope chooses between the filtered set and the
 * selection. It is cleared explicitly or when the bundle changes.
 */

import { COLUMNS, sortRows, pageSlice, stats, toCsv, fmtMoney } from './lib/results.js';
import { describeFilters } from './lib/exports.js';
import { copyForWord, exportXlsx, downloadBlob, stamp } from './exports.js';

const PAGE_SIZE = 100;
const SORT_KEY = 'mbre_sort_v1';

const fmt = (n) => Number(n || 0).toLocaleString('en-CA');

export function initResultsTable({ getPolicy, getContext, setStatus, onEvidence } = {}) {
  const $ = (id) => document.getElementById(id);
  const $table = $('results-table');
  const $thead = $table.querySelector('thead');
  const $tbody = $table.querySelector('tbody');
  const $count = $('count-line');
  const $medians = $('median-line');
  const $pager = $('pager');
  const $prev = $('page-prev');
  const $next = $('page-next');
  const $pageLabel = $('page-label');
  const $card = $('results-card');
  const $scope = $('export-scope');
  const $selOnly = $('selected-only');
  const $selClear = $('selection-clear');
  const $csv = $('export-csv');
  const $xlsx = $('export-xlsx');
  const $word = $('export-word');

  let rows = [];                 // filtered rows, unsorted
  let sorted = [];               // filtered rows, sorted (what exports use)
  let sort = { key: 'last_seen', dir: 'desc' };
  let page = 1;
  const selected = new Set();    // listing ids
  try { const s = JSON.parse(localStorage.getItem(SORT_KEY) || 'null'); if (s?.key) sort = s; } catch { /* ignore */ }

  const say = (m) => { if (typeof setStatus === 'function') setStatus(m); };

  // ---- header ------------------------------------------------------------
  const tr = document.createElement('tr');
  const thSel = document.createElement('th');
  thSel.className = 'sel';
  const selAll = document.createElement('input');
  selAll.type = 'checkbox';
  selAll.title = 'Select every row on this page';
  selAll.setAttribute('aria-label', 'Select all rows on this page');
  thSel.appendChild(selAll);
  tr.appendChild(thSel);
  for (const c of COLUMNS) {
    const th = document.createElement('th');
    th.dataset.key = c.key;
    th.className = c.num ? 'num sortable' : 'sortable';
    th.setAttribute('aria-sort', 'none');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'th-btn'; b.textContent = c.label;
    th.appendChild(b);
    tr.appendChild(th);
  }
  const thLink = document.createElement('th'); thLink.textContent = 'Link';
  tr.appendChild(thLink);
  const thEv = document.createElement('th'); thEv.textContent = 'Page';
  thEv.title = 'Archived copy of the listing page, opened from the connected folder';
  tr.appendChild(thEv);
  $thead.textContent = '';
  $thead.appendChild(tr);

  $tbody.addEventListener('click', (e) => {
    const b = e.target.closest('button.evidence-btn');
    if (!b) return;
    const l = rows.find((x) => x.id === Number(b.dataset.id));
    if (l) onEvidence?.(l);
  });

  $thead.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    const key = th.dataset.key;
    sort = sort.key === key
      ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: COLUMNS.find((c) => c.key === key)?.num ? 'desc' : 'asc' };
    try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch { /* ignore */ }
    page = 1;
    render();
  });

  let pageIds = [];
  selAll.addEventListener('change', () => {
    for (const id of pageIds) { if (selAll.checked) selected.add(id); else selected.delete(id); }
    render();
  });
  $tbody.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.matches('input.row-sel')) return;
    const id = Number(cb.value);
    if (cb.checked) selected.add(id); else selected.delete(id);
    renderSelection();
  });

  $prev.addEventListener('click', () => { page--; render(); });
  $next.addEventListener('click', () => { page++; render(); });
  $selOnly.addEventListener('change', () => { page = 1; render(); });
  $selClear.addEventListener('click', () => { selected.clear(); render(); });
  $scope.addEventListener('change', renderSelection);

  // ---- exports ------------------------------------------------------------
  function exportRows() {
    return $scope.value === 'selected' ? sorted.filter((l) => selected.has(l.id)) : sorted;
  }
  function exportMeta(n) {
    const ctx = getContext?.() || {};
    const criteria = [
      ...(ctx.filters ? describeFilters(ctx.filters, { asOf: ctx.asOf, policy: getPolicy?.() }) : []),
      ...(ctx.extraCriteria || []),
    ];
    if ($scope.value === 'selected') criteria.push(`Hand-picked selection of ${n} from the filtered set`);
    const s = stats(rows, getPolicy?.() || {});
    const note = [
      `${n} listing${n === 1 ? '' : 's'}`,
      s.medianRent != null ? `filtered-set median rent ${fmtMoney(s.medianRent)}` : null,
      ctx.published ? `data published ${ctx.published}` : null,
    ].filter(Boolean).join(' · ');
    return { title: 'Rental listings', criteria, note };
  }

  $csv.addEventListener('click', () => {
    const r = exportRows();
    if (!r.length) return;
    downloadBlob(new Blob([toCsv(r)], { type: 'text/csv;charset=utf-8' }), `rentals-${stamp()}.csv`);
    say(`CSV of ${fmt(r.length)} listings downloaded.`);
  });
  $xlsx.addEventListener('click', async () => {
    const r = exportRows();
    if (!r.length) return;
    say('Building workbook…');
    try {
      await exportXlsx(r, exportMeta(r.length));
      say(`Excel workbook of ${fmt(r.length)} listings downloaded.`);
    } catch (err) { say(`Excel export failed: ${err.message}`); }
  });
  $word.addEventListener('click', async () => {
    const r = exportRows();
    if (!r.length) return;
    const how = await copyForWord(r, exportMeta(r.length));
    say(how === 'rich' ? `Copied ${fmt(r.length)} listings for Word — paste into the report.`
      : how === 'text' ? `Copied ${fmt(r.length)} listings as plain text (rich copy unavailable in this browser).`
        : 'Copy failed — the browser refused clipboard access.');
  });

  // ---- rendering ---------------------------------------------------------
  function td(text, cls) {
    const cell = document.createElement('td');
    cell.textContent = text ?? '';
    if (cls) cell.className = cls;
    return cell;
  }

  let note = '';
  function renderCount() {
    const s = stats(rows, getPolicy?.() || {});
    const parts = [`${fmt(s.n)} listing${s.n === 1 ? '' : 's'}${note ? ` (${note})` : ''}`];
    if (s.canonical !== s.n) parts.push(`${fmt(s.canonical)} canonical`);
    parts.push(s.medianRent != null ? `median rent ${fmtMoney(s.medianRent)}` : `median suppressed (n < ${s.minN} in band)`);
    if (s.medianPsf != null) parts.push(`median $${s.medianPsf.toFixed(2)}/sf`);
    $count.textContent = parts.join(' · ');
    const labels = { studio: 'Studio', '1br': '1 BR', '2br': '2 BR', '3br': '3 BR', '4plus': '4+ BR' };
    $medians.textContent = s.byBand
      .map((b) => `${labels[b.key] || b.key}: ${b.median != null ? fmtMoney(b.median) : '—'} (n=${fmt(b.n)})`)
      .join('   ');
  }

  function renderSelection() {
    const inFiltered = sorted.reduce((n, l) => n + (selected.has(l.id) ? 1 : 0), 0);
    const n = exportRows().length;
    $scope.options[0].textContent = `Filtered (${fmt(sorted.length)})`;
    $scope.options[1].textContent = `Selected (${fmt(inFiltered)})`;
    $selOnly.disabled = selected.size === 0;
    $selClear.hidden = selected.size === 0;
    $selClear.textContent = `✕ Clear ${fmt(selected.size)} selected`;
    for (const b of [$csv, $xlsx, $word]) b.disabled = n === 0;
    selAll.checked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
    selAll.indeterminate = !selAll.checked && pageIds.some((id) => selected.has(id));
    for (const tr of $tbody.rows) tr.classList.toggle('is-selected', selected.has(Number(tr.dataset.id)));
  }

  function render() {
    sorted = sortRows(rows, sort.key, sort.dir);
    for (const th of $thead.querySelectorAll('th[data-key]')) {
      th.setAttribute('aria-sort', th.dataset.key === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    const view = $selOnly.checked && selected.size ? sorted.filter((l) => selected.has(l.id)) : sorted;
    const slice = pageSlice(view, page, PAGE_SIZE);
    page = slice.page;
    pageIds = slice.rows.map((l) => l.id);
    $tbody.textContent = '';
    const frag = document.createDocumentFragment();
    for (const l of slice.rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = String(l.id);
      const selCell = document.createElement('td');
      selCell.className = 'sel';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'row-sel'; cb.value = String(l.id); cb.checked = selected.has(l.id);
      cb.setAttribute('aria-label', 'Select this listing');
      selCell.appendChild(cb);
      tr.appendChild(selCell);
      for (const c of COLUMNS) {
        const cell = td(c.text(l), c.num ? 'num' : undefined);
        if (c.key === 'address' && l.title) cell.title = l.title;
        tr.appendChild(cell);
      }
      const linkCell = document.createElement('td');
      if (l.url) {
        const a = document.createElement('a');
        a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '↗';
        a.title = 'Open the listing on its source site';
        linkCell.appendChild(a);
      }
      tr.appendChild(linkCell);
      const evCell = document.createElement('td');
      if (l.evidence_path) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'evidence-btn'; b.dataset.id = String(l.id); b.textContent = '📄';
        b.title = `Open the archived page (${l.evidence_path.split('/')[1] || ''})`;
        b.setAttribute('aria-label', 'Open archived listing page');
        evCell.appendChild(b);
      }
      tr.appendChild(evCell);
      frag.appendChild(tr);
    }
    $tbody.appendChild(frag);
    $pager.hidden = slice.pages <= 1;
    $pageLabel.textContent = `Page ${slice.page} of ${slice.pages}` + ($selOnly.checked && selected.size ? ' (selected only)' : '');
    $prev.disabled = slice.page <= 1;
    $next.disabled = slice.page >= slice.pages;
    renderCount();
    renderSelection();
  }

  return {
    setRows(next, { note: n = '' } = {}) {
      rows = next || [];
      note = n;
      page = 1;
      $card.hidden = false;
      render();
    },
    clear() {
      rows = []; sorted = []; pageIds = [];
      selected.clear();
      $tbody.textContent = '';
      $card.hidden = true;
      $count.textContent = '';
      $medians.textContent = '';
      for (const b of [$csv, $xlsx, $word]) b.disabled = true;
    },
    clearSelection() { selected.clear(); render(); },
    getSelectedIds: () => [...selected],
    getExportRows: exportRows,
  };
}
