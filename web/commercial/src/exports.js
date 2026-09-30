/*
 * exports.js — the browser side of the exports: clipboard, file
 * downloads, the XLSX workbook (exceljs, loaded on first use so the
 * ~1 MB library never delays the page), and the map PNG.
 */

import { buildWordHtml, buildWordText, xlsxRows, XLSX_FORMATS, provenanceLines } from './lib/exports.js';
import { COLUMNS } from './lib/results.js';

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const stamp = () => new Date().toISOString().slice(0, 10);

/** Copy the table for Word: rich HTML with a plain-text twin, falling
 *  back to text alone, then to nothing. 'rich' | 'text' | 'failed'. */
export async function copyForWord(rows, opts) {
  const html = buildWordHtml(rows, opts);
  const text = buildWordText(rows, opts);
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return 'rich';
    }
  } catch { /* fall through to plain text */ }
  try {
    await navigator.clipboard.writeText(text);
    return 'text';
  } catch { return 'failed'; }
}

/**
 * The workbook: a "Listings" sheet with typed cells, number formats, a
 * frozen auto-filtered header, and a "Criteria" sheet saying how the set
 * was chosen. The criteria sheet is the point — a spreadsheet that has
 * lost its question is worse than no spreadsheet.
 */
export async function exportXlsx(rows, { chips = [], published = null, cycle = null, title = 'Commercial availability', note = '' } = {}) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Commercial Availability Explorer';
  wb.created = new Date();

  const ws = wb.addWorksheet('Listings', { views: [{ state: 'frozen', ySplit: 1 }] });
  const { header, labels, rows: data } = xlsxRows(rows);
  ws.addRow(labels);
  const head = ws.getRow(1);
  head.font = { name: 'Calibri', size: 11, bold: true };
  head.border = { bottom: { style: 'thin', color: { argb: 'FF1F5F8B' } } };
  for (const r of data) ws.addRow(r);
  header.forEach((key, i) => {
    const col = ws.getColumn(i + 1);
    if (XLSX_FORMATS[key]) col.numFmt = XLSX_FORMATS[key];
    const widths = { address: 32, municipality: 24, area: 22, brokerage: 22, zoning: 14, status: 20 };
    col.width = widths[key] || Math.max(10, Math.min(18, (COLUMNS[i]?.label || key).length + 4));
  });
  if (data.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: labels.length } };
  }

  const cs = wb.addWorksheet('Criteria');
  cs.getColumn(1).width = 100;
  cs.addRow([title]).font = { name: 'Calibri', size: 12, bold: true };
  for (const line of provenanceLines({ chips, published, cycle, count: rows.length })) cs.addRow([line]);
  if (note) cs.addRow([note]);
  cs.addRow([`Exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `availability-${cycle || stamp()}.xlsx`,
  );
  return rows.length;
}

/**
 * PNG of the map as currently viewed, at the site's fixed chart-image size
 * (1950 × 1050, 300 DPI) with a legend strip and the attribution drawn on —
 * see ../../src/subapp-map-png.js (which also carries the note on reading the
 * canvas back inside a render callback, learned here).
 */
export async function exportMapPng(map, legend = [], filename = `availability-map-${stamp()}.png`) {
  const { exportFixedMapPng } = await import('../../src/subapp-map-png.js');
  return exportFixedMapPng(map, legend, filename);
}
