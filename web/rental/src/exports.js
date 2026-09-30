/*
 * exports.js — the browser side of the report exports: clipboard,
 * file downloads, the XLSX workbook (exceljs, loaded on first use so
 * the ~1 MB library never delays the page), and the map PNG.
 */

import { buildWordHtml, buildWordText, xlsxRows, XLSX_FORMATS } from './lib/exports.js';

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * Copy rows for Word. Rich HTML with a TSV twin, then the same fallback
 * chain the housing site uses.
 * @returns {Promise<'rich'|'text'|'failed'>}
 */
export async function copyForWord(rows, opts) {
  return copyRich(buildWordHtml(rows, opts), buildWordText(rows, opts));
}

/** Put HTML + a plain-text twin on the clipboard. 'rich' | 'text' | 'failed'. */
export async function copyRich(html, text) {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return 'rich';
    }
  } catch { /* fall through */ }
  try {
    await navigator.clipboard.writeText(text);
    return 'text';
  } catch { return 'failed'; }
}

/**
 * Listings workbook: a "Listings" sheet (typed cells, number formats,
 * bold header with the dark-red rule, frozen + auto-filtered) and a
 * "Criteria" sheet documenting how the set was chosen.
 */
export async function exportXlsx(rows, { criteria = [], title = 'Rental listings', note = '' } = {}) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Manitoba Rental Explorer';
  wb.created = new Date();

  const ws = wb.addWorksheet('Listings', { views: [{ state: 'frozen', ySplit: 1 }] });
  const { header, rows: data } = xlsxRows(rows);
  ws.addRow(header);
  const head = ws.getRow(1);
  head.font = { name: 'Calibri', size: 11, bold: true };
  head.border = { bottom: { style: 'thin', color: { argb: 'FF8B0000' } } };
  for (const r of data) ws.addRow(r);
  header.forEach((k, i) => {
    const col = ws.getColumn(i + 1);
    if (XLSX_FORMATS[k]) col.numFmt = XLSX_FORMATS[k];
    const widths = { url: 40, title: 36, address: 30, geo_neighborhood: 22, geo_municipality: 22, description: 40 };
    col.width = widths[k] || Math.max(10, Math.min(18, k.length + 2));
  });
  if (data.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };

  const cs = wb.addWorksheet('Criteria');
  cs.getColumn(1).width = 100;
  cs.addRow([title]).font = { name: 'Calibri', size: 12, bold: true };
  for (const line of criteria) cs.addRow([line]);
  cs.addRow([`${rows.length} listing${rows.length === 1 ? '' : 's'}`]);
  if (note) cs.addRow([note]);
  cs.addRow([`Exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from Manitoba Rental Explorer`]);

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `rentals-${stamp()}.xlsx`);
}

/**
 * PNG of the map as currently shown, with the legend strip and the
 * attribution drawn on. Needs the map created with preserveDrawingBuffer.
 * @param {maplibregl.Map} map
 * @param {Array<{label:string,color:string}>} legend
 */
export function exportMapPng(map, legend = [], filename = `rentals-map-${stamp()}.png`) {
  const src = map.getCanvas();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const strip = Math.round(26 * dpr);
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height + strip;
  const g = out.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(src, 0, 0);
  // attribution, bottom-right of the map area
  g.font = `${Math.round(10 * dpr)}px Inter, Arial, sans-serif`;
  const attr = '© Protomaps © OpenStreetMap contributors';
  const aw = g.measureText(attr).width + 10 * dpr;
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillRect(out.width - aw, src.height - 16 * dpr, aw, 16 * dpr);
  g.fillStyle = '#333';
  g.fillText(attr, out.width - aw + 5 * dpr, src.height - 5 * dpr);
  // legend strip
  g.font = `${Math.round(11 * dpr)}px Inter, Arial, sans-serif`;
  let x = 8 * dpr;
  const y = src.height + strip / 2;
  for (const item of legend) {
    g.fillStyle = item.color;
    g.beginPath(); g.arc(x + 5 * dpr, y, 5 * dpr, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#333';
    g.fillText(item.label, x + 14 * dpr, y + 4 * dpr);
    x += 14 * dpr + g.measureText(item.label).width + 16 * dpr;
  }
  return new Promise((resolve) => {
    out.toBlob((blob) => { if (blob) downloadBlob(blob, filename); resolve(Boolean(blob)); }, 'image/png');
  });
}
