/*
 * exports.js (lib) — the part of the exports that is pure text: the
 * Word-bound HTML table and its plain-text twin, and the typed rows an
 * Excel workbook is built from. Node-tested; exports.js one level up
 * does the clipboard, the downloads and the canvas.
 *
 * Every export states what it is: the publish date and the filters that
 * produced it travel with the rows, so a spreadsheet found in someone's
 * Downloads folder six months from now still says which market, which
 * cycle, and on what terms.
 */

import { COLUMNS } from './results.js';

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The columns a pasted or exported table carries. Narrower than the
 *  grid: a Word table wider than this is unreadable on a page. */
export const REPORT_KEYS = Object.freeze([
  'address', 'unit', 'municipality', 'space_type', 'listing_type',
  'size', 'asking', 'rate', 'status', 'brokerage', 'last_seen',
]);

const reportColumns = () => REPORT_KEYS
  .map((key) => COLUMNS.find((c) => c.key === key))
  .filter(Boolean);

/** A heading line stating what the reader is looking at. */
export function provenanceLines({ chips = [], published = null, cycle = null, count = null } = {}) {
  const lines = [];
  if (count != null) lines.push(`${Number(count).toLocaleString('en-CA')} listing${count === 1 ? '' : 's'}`);
  for (const chip of chips) lines.push(chip.label ?? String(chip));
  if (cycle) lines.push(`Data cycle ${cycle}`);
  if (published) lines.push(`Published ${published}`);
  return lines;
}

/**
 * An HTML table Word will accept from the clipboard. Inline styles only
 * — Word ignores a stylesheet, and a table without borders pastes as a
 * run-on paragraph.
 */
export function buildWordHtml(rows, { title = 'Commercial availability', chips = [], published = null, cycle = null, note = '' } = {}) {
  const cols = reportColumns();
  const head = cols.map((c) => `<th style="border:1px solid #999;padding:4px 6px;background:#eee;text-align:left">${escapeHtml(c.label)}</th>`).join('');
  const body = rows.map((r) => {
    const tds = cols.map((c) => {
      const align = c.num ? 'right' : 'left';
      return `<td style="border:1px solid #999;padding:3px 6px;text-align:${align}">${escapeHtml(c.text(r))}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  const lines = provenanceLines({ chips, published, cycle, count: rows.length })
    .map((l) => `<div style="font-size:9pt;color:#555">${escapeHtml(l)}</div>`).join('');
  return `<html><body>
<div style="font-family:Calibri,Arial,sans-serif">
<div style="font-size:12pt;font-weight:bold">${escapeHtml(title)}</div>
${lines}
${note ? `<div style="font-size:9pt;color:#555">${escapeHtml(note)}</div>` : ''}
<table style="border-collapse:collapse;font-size:9pt;margin-top:6px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</div></body></html>`;
}

/** The plain-text twin of the same table, tab-separated. */
export function buildWordText(rows, { title = 'Commercial availability', chips = [], published = null, cycle = null, note = '' } = {}) {
  const cols = reportColumns();
  const out = [title, ...provenanceLines({ chips, published, cycle, count: rows.length })];
  if (note) out.push(note);
  out.push('');
  out.push(cols.map((c) => c.label).join('\t'));
  for (const r of rows) out.push(cols.map((c) => c.text(r)).join('\t'));
  return out.join('\n');
}

/** Number formats for the workbook, by column key. */
export const XLSX_FORMATS = Object.freeze({
  size: '#,##0',
  land_acres: '#,##0.00',
  units: '#,##0',
  asking: '#,##0.00',
  rate: '$#,##0.00',
  additional_rent: '$#,##0.00',
  months_on_market: '0',
  dist: '0.0',
});

/**
 * Typed rows for Excel: numbers stay numbers so a column can be summed
 * or sorted in the spreadsheet, rather than arriving as "$1,250,000"
 * text the way the on-screen grid formats them.
 */
export function xlsxRows(rows) {
  const header = COLUMNS.map((c) => c.key);
  const data = rows.map((r) => COLUMNS.map((c) => {
    const raw = c.get(r);
    if (c.num) return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return raw === '' ? null : raw;
  }));
  return { header, labels: COLUMNS.map((c) => c.label), rows: data };
}
