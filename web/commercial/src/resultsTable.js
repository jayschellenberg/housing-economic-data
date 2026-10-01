/*
 * resultsTable.js — the grid: sortable headers, paging, the count line,
 * and the CSV download. All of the arithmetic and formatting is in
 * lib/results.js; this only renders and wires events.
 *
 * Rows are paged rather than all rendered: the bundle carries 8,880
 * records and "All records" with no filter is a legitimate view, but
 * 8,880 DOM rows is not.
 */

import {
  COLUMNS, sortRows, pageOf, pageCount, summarize, countLine, medianLine, toCsv, linksOf,
} from './lib/results.js';
import { exportXlsx, copyForWord } from './exports.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 100;

// The Links column sits right after Address. It was an unlabelled 23rd
// column: on a 1,400px screen the first Flyer button was at x = 2,690px,
// a scroll of 1,700px that nobody makes for a column with no header.
const LINKS_AFTER = 'address';

function linksHeader() {
  const th = document.createElement('th');
  th.scope = 'col';
  th.className = 'col-links';
  th.textContent = 'Links';
  return th;
}

export function initResultsTable({ getContext, setStatus, onFlyer, onSnapshot } = {}) {
  const table = $('results-table');
  if (!table) return { render() {} };
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  function linksCell(r) {
    const td = document.createElement('td');
    td.className = 'col-links';
    for (const link of linksOf(r)) {
      let el;
      if (link.href) {
        el = document.createElement('a');
        el.href = link.href;
        el.target = '_blank';
        // No referrer: the page address says nothing useful to Moody's,
        // and the listing is found by its id, not by where you came from.
        el.rel = 'noopener noreferrer';
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.addEventListener('click', () => (link.kind === 'snapshot' ? onSnapshot : onFlyer)?.(r));
      }
      el.className = 'link-btn';
      el.textContent = link.label;
      el.title = link.title || '';
      td.appendChild(el);
    }
    return td;
  }

  let rows = [];            // the filtered set, unsorted
  let sortKey = 'address';
  let sortDir = 'asc';
  let page = 1;

  // ---- header ------------------------------------------------------------
  const headRow = document.createElement('tr');
  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.scope = 'col';
    // The per-column class carries the width: 18 columns in a
    // width:100% table let the browser crush Address to two characters.
    th.className = `col-${col.key} sortable${col.num ? ' num' : ''}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'th-btn';
    btn.textContent = col.label;
    btn.addEventListener('click', () => {
      if (sortKey === col.key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = col.key;
        // Numbers are most useful biggest-first; text A-Z.
        sortDir = col.num ? 'desc' : 'asc';
      }
      page = 1;
      draw();
    });
    th.appendChild(btn);
    headRow.appendChild(th);
    if (col.key === LINKS_AFTER) headRow.appendChild(linksHeader());
  }
  thead.textContent = '';
  thead.appendChild(headRow);

  // ---- body --------------------------------------------------------------
  function draw() {
    const sorted = sortRows(rows, sortKey, sortDir);
    const total = pageCount(sorted.length, PAGE_SIZE);
    if (page > total) page = total;
    const slice = pageOf(sorted, page, PAGE_SIZE);

    tbody.textContent = '';
    for (const r of slice) {
      const tr = document.createElement('tr');
      for (const col of COLUMNS) {
        const td = document.createElement('td');
        td.textContent = col.text(r);
        td.className = `col-${col.key}${col.num ? ' num' : ''}`;
        // Every cell gets the full value on hover: the columns are
        // ellipsised, and "(unit unverified)" is exactly the sort of
        // qualifier that must not be the part that gets cut off.
        td.title = td.textContent;
        tr.appendChild(td);
        if (col.key === LINKS_AFTER) tr.appendChild(linksCell(r));
      }
      tbody.appendChild(tr);
    }

    for (const th of thead.querySelectorAll('th')) th.removeAttribute('aria-sort');
    // By class, not by position: the Links column is not one of COLUMNS,
    // so a COLUMNS index stopped being a DOM index the moment it moved to
    // second place, and the "sorted" marker landed on the header to its left.
    thead.querySelector(`th.col-${sortKey}`)
      ?.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');

    const ctx = getContext?.() || {};
    const stats = summarize(rows, ctx.manifest);
    $('count-line').textContent = countLine(stats) + (ctx.viewNote ? ` (${ctx.viewNote})` : '');
    $('median-line').textContent = medianLine(stats);
    $('pager-label').textContent = sorted.length
      ? `Page ${page} of ${total} · showing ${slice.length} of ${sorted.length.toLocaleString('en-CA')}`
      : 'Nothing matches these filters.';
    $('page-prev').disabled = page <= 1;
    $('page-next').disabled = page >= total;
    for (const id of ['export-csv', 'export-xlsx', 'export-word']) {
      const btn = $(id);
      if (btn) btn.disabled = sorted.length === 0;
    }
  }

  $('page-prev')?.addEventListener('click', () => { page = Math.max(1, page - 1); draw(); });
  $('page-next')?.addEventListener('click', () => { page += 1; draw(); });

  // ---- CSV ---------------------------------------------------------------
  $('export-csv')?.addEventListener('click', () => {
    const ctx = getContext?.() || {};
    // The whole filtered set, in the sort on screen — not just this page.
    const csv = toCsv(sortRows(rows, sortKey, sortDir), {
      chips: ctx.chips || [],
      published: ctx.published || null,
    });
    const stamp = (ctx.cycle || new Date().toISOString().slice(0, 7)).replace(/-/g, '');
    downloadText(csv, `availability_${stamp}.csv`);
    setStatus?.(`Exported ${rows.length.toLocaleString('en-CA')} listings to CSV.`);
  });

  /** What every export states about itself. */
  function exportContext() {
    const ctx = getContext?.() || {};
    return {
      chips: ctx.chips || [],
      published: ctx.published || null,
      cycle: ctx.cycle || null,
      note: ctx.note || '',
    };
  }

  $('export-xlsx')?.addEventListener('click', async () => {
    const btn = $('export-xlsx');
    btn.disabled = true;
    setStatus?.('Building the workbook…');
    try {
      const n = await exportXlsx(sortRows(rows, sortKey, sortDir), exportContext());
      setStatus?.(`Exported ${n.toLocaleString('en-CA')} listings to Excel.`);
    } catch (err) {
      setStatus?.(`Excel export failed: ${err.message}`);
    } finally {
      btn.disabled = rows.length === 0;
    }
  });

  $('export-word')?.addEventListener('click', async () => {
    // A Word table of 8,880 rows is not a document anyone wants; the
    // clipboard path is for a shortlist, so it takes the page on screen.
    const slice = pageOf(sortRows(rows, sortKey, sortDir), page, PAGE_SIZE);
    const how = await copyForWord(slice, exportContext());
    setStatus?.(how === 'failed'
      ? 'The browser would not give access to the clipboard.'
      : `Copied ${slice.length} listing${slice.length === 1 ? '' : 's'} `
        + `${how === 'rich' ? 'as a table' : 'as text'} — paste into Word.`);
  });

  function render(next) {
    rows = next || [];
    page = 1;
    draw();
  }

  return { render, redraw: draw };
}

function downloadText(text, filename) {
  // BOM so Excel opens the UTF-8 addresses correctly on Windows.
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
