/*
 * Excel export for the comparison-tables view. Replicates the firm's
 * appraisal SampleTables.xlsx look: merged title row above each table,
 * dark-red header row with white text, thin black borders, left-aligned
 * area names, centred numeric cells, Calibri 11.
 *
 * One worksheet per file, each rendered table block separated by a blank
 * row. Pre-formatted strings (e.g. "$1,210", "2.6%") are written as text;
 * the original numeric values aren't preserved because the source tool
 * never persisted them either.
 */

import ExcelJS from 'exceljs';

const BRAND_RED = 'FF7C1014';
const BORDER_THIN = { style: 'thin', color: { argb: 'FF595959' } };

/**
 * @param {Array} built  list of rendered tables (output of tables.js render)
 * @param {Object} opts  { filename, maxYear }
 */
export async function exportTablesToExcel(built, { filename, maxYear }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CMHC Charts';
  wb.created = new Date();
  const ws = wb.addWorksheet('CMHC Tables', {
    properties: { defaultColWidth: 14 },
    pageSetup: { paperSize: 9, orientation: 'landscape' },
  });

  let row = 1;
  built.forEach((table, i) => {
    // Compute width: 1 (area col) + N category columns
    const nCols = 1 + table.columns.length;

    // ── Title row (merged across all columns) ──
    ws.mergeCells(row, 1, row, nCols);
    const titleCell = ws.getCell(row, 1);
    titleCell.value = `${table.title}${table.dwellingSuffix || ''} — CMHC ${maxYear} October`;
    titleCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: BRAND_RED } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    titleCell.border = {
      top:    BORDER_THIN, bottom: BORDER_THIN,
      left:   BORDER_THIN, right:  BORDER_THIN,
    };
    row++;

    // ── Header row ──
    const headerRow = ws.getRow(row);
    headerRow.values = ['', ...table.columns];
    headerRow.eachCell((cell, col) => {
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
      cell.border = {
        top: BORDER_THIN, bottom: BORDER_THIN,
        left: BORDER_THIN, right: BORDER_THIN,
      };
    });
    row++;

    // ── Body rows ──
    table.rows.forEach((r) => {
      const dataRow = ws.getRow(row);
      dataRow.values = [r.area, ...r.values.map(v => (v == null ? '**' : v))];
      dataRow.eachCell((cell, col) => {
        cell.font = { name: 'Calibri', size: 11 };
        cell.border = {
          top: BORDER_THIN, bottom: BORDER_THIN,
          left: BORDER_THIN, right: BORDER_THIN,
        };
        if (col === 1) {
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
          cell.font = { name: 'Calibri', size: 11, bold: true };
        } else {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          if (cell.value === '**') {
            cell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FF95A5A6' } };
          }
        }
      });
      row++;
    });

    // Blank spacer row between tables.
    if (i < built.length - 1) row++;
  });

  // Column widths — area column wider than the numeric ones.
  ws.getColumn(1).width = 24;
  const maxColCount = built.reduce((m, t) => Math.max(m, 1 + t.columns.length), 1);
  for (let c = 2; c <= maxColCount; c++) ws.getColumn(c).width = 14;

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
