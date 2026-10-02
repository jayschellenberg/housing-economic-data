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

// Number formats by indicator `units`, shared by the Market Indicators and
// Agriculture data exports. Percent series hold 4.75 for 4.75%; the cell gets
// the fraction (indicatorCellValue) so Excel treats it as a true percentage,
// not 4.75 with a "%" sign.
const FMT_NUMBER = {
  percent: '0.00%',
  dollar:  '#,##0',
  dollar_millions: '#,##0',
  dollar_per_cwt: '#,##0.00',
  dollar_per_dozen: '#,##0.00',
  dollar_per_kg: '#,##0.00',
  dollar_per_kl: '#,##0.00',
  dollar_per_tonne: '#,##0.00',
  acres:   '#,##0',
  index:   '0.00',
  units:   '#,##0',
  persons: '#,##0',
  ratio:   '0.00',
  balance_of_opinion: '0',
};
const indicatorCellValue = (v, units) => (v == null || !Number.isFinite(v) ? null
  : units === 'percent' ? Math.round(v * 1e6) / 1e8 : v);

function styleHeaderRow(row) {
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
    c.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { vertical: 'top', horizontal: 'center', wrapText: true };
    c.border = { top: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN, bottom: BORDER_THIN };
  });
}

/**
 * @param {Array} built  list of rendered tables (output of tables.js render)
 * @param {Object} opts  { filename, maxYear }
 */
export async function exportTablesToExcel(built, { filename, maxYear, titleNote, sheetName }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Housing & Economic Data';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName || 'CMHC Tables', {
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
    const note = titleNote != null ? titleNote : `— CMHC ${maxYear} October`;
    titleCell.value = `${table.title}${table.dwellingSuffix || ''} ${note}`.trim();
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
    headerRow.eachCell((cell) => {
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
  triggerDownload(blob, filename);
}

/**
 * Export every loaded Market-Indicators shard into one workbook. One sheet
 * per displayGroup. Plus a Metadata sheet listing source URLs, vintages,
 * units, and notes — for appraisal defensibility.
 */
export async function exportIndicatorsToExcel({ catalog, shards }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Housing & Economic Data';
  wb.created = new Date();

  // One sheet per group, in catalog order. Groups tagged for another tab (e.g.
  // Agriculture) are exported from that tab, not the Market Indicators workbook.
  const groupOrder = Object.entries(catalog.displayGroups || {})
    .filter(([, g]) => (g.tab || 'indicators') === 'indicators')
    .sort((a, b) => (a[1].order || 99) - (b[1].order || 99))
    .map(([id]) => id);

  for (const groupId of groupOrder) {
    const shard = shards[groupId];
    if (!shard || !shard.series?.length) continue;
    const ws = wb.addWorksheet(catalog.displayGroups[groupId].title.slice(0, 31), {
      properties: { defaultColWidth: 14 },
    });

    // Header row: Date | series1 | series2 | ...
    const seriesIds = shard.series.map(s => s.id);
    const headers = ['Date', ...shard.series.map(s => `${s.chartLabel || s.id}\n(${s.title})`)];
    const headerRow = ws.addRow(headers);
    headerRow.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
      c.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      c.alignment = { vertical: 'top', horizontal: 'center', wrapText: true };
      c.border = { top: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN, bottom: BORDER_THIN };
    });
    headerRow.height = 36;

    // Pivot records by date.
    const byDate = new Map();
    (shard.records || []).forEach(r => {
      if (!byDate.has(r.date)) byDate.set(r.date, {});
      byDate.get(r.date)[r.id] = r.value;
    });
    const sortedDates = [...byDate.keys()].sort();

    sortedDates.forEach(d => {
      const row = [d, ...seriesIds.map((id, i) => indicatorCellValue(byDate.get(d)?.[id], shard.series[i].units))];
      const r = ws.addRow(row);
      r.getCell(1).alignment = { horizontal: 'left' };
      r.eachCell((cell, colNumber) => {
        cell.font = { name: 'Calibri', size: 10 };
        cell.border = { top: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN, bottom: BORDER_THIN };
        if (colNumber > 1) {
          cell.alignment = { horizontal: 'right' };
          const s = shard.series[colNumber - 2];
          if (s) cell.numFmt = FMT_NUMBER[s.units] || '0.00';
        }
      });
    });
    ws.getColumn(1).width = 12;
    for (let c = 2; c <= headers.length; c++) ws.getColumn(c).width = 16;
  }

  // Metadata sheet — appraiser defensibility.
  const meta = wb.addWorksheet('Metadata', { properties: { defaultColWidth: 22 } });
  const metaHeaders = ['Group', 'Series ID', 'Title', 'Provider', 'Geo', 'Frequency', 'Units', 'Latest date', 'Source URL'];
  const mh = meta.addRow(metaHeaders);
  mh.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_RED } };
    c.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', wrapText: true };
    c.border = { top: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN, bottom: BORDER_THIN };
  });
  groupOrder.forEach(groupId => {
    const shard = shards[groupId];
    if (!shard) return;
    (shard.series || []).forEach(s => {
      meta.addRow([
        catalog.displayGroups[groupId]?.title || groupId,
        s.id,
        s.title,
        s.provider,
        s.geo,
        s.frequency,
        s.units,
        s.latestDate ?? '',
        s.sourceUrl ?? '',
      ]);
    });
  });
  meta.getColumn(3).width = 50;
  meta.getColumn(9).width = 70;
  meta.addRow([]);
  meta.addRow(['Exported', new Date().toISOString().slice(0, 10)]);
  meta.addRow(['App', 'https://housing-economic-data.vercel.app/']);
  meta.addRow(['Caveats', 'Public data, see source URLs for definitions. Verify before relying on for appraisals.']);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  triggerDownload(blob, `MarketIndicators_${new Date().toISOString().slice(0,10)}.xlsx`);
}

/**
 * One worksheet per chart, exactly as charted: the series and date range on
 * screen, in the chart's legend order, plus a Sources sheet. Used by the
 * Agriculture tab, whose charts draw from several indicator shards at once.
 *
 * @param {Array<{title, subtitle, source, sources, series, records}>} charts
 *   series: [{ id, chartLabel, units }]; records: [{ id, date, value }];
 *   sources: [{ citation, url?, detail? }]
 * @param {{ filename: string, heading: string }} opts
 */
export async function exportChartDataToExcel(charts, { filename, heading }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Housing & Economic Data';
  wb.created = new Date();
  const used = new Set();
  const safe = (s) => s.replace(/[\\/?*[\]:]/g, ' ');
  for (const ch of charts) {
    let name = safe(ch.title).slice(0, 31).trim();
    for (let n = 2; used.has(name); n++) name = `${safe(ch.title).slice(0, 27).trim()} ${n}`;
    used.add(name);
    const ws = wb.addWorksheet(name, { properties: { defaultColWidth: 14 } });
    ws.addRow([ch.title]).font = { name: 'Calibri', size: 12, bold: true };
    if (ch.subtitle) ws.addRow([ch.subtitle]).font = { name: 'Calibri', size: 10 };
    if (ch.source) ws.addRow([`Source: ${ch.source}`]).font = { name: 'Calibri', size: 10, italic: true };
    ws.addRow([]);
    styleHeaderRow(ws.addRow(['Date', ...ch.series.map(s => s.chartLabel || s.id)]));
    const byDate = new Map();
    for (const r of ch.records) {
      if (!byDate.has(r.date)) byDate.set(r.date, {});
      byDate.get(r.date)[r.id] = r.value;
    }
    for (const d of [...byDate.keys()].sort()) {
      const r = ws.addRow([d, ...ch.series.map(s => indicatorCellValue(byDate.get(d)[s.id], s.units))]);
      r.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.font = { name: 'Calibri', size: 10 };
        cell.border = { top: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN, bottom: BORDER_THIN };
        if (col > 1) {
          cell.alignment = { horizontal: 'right' };
          cell.numFmt = FMT_NUMBER[ch.series[col - 2]?.units] || '0.00';
        }
      });
    }
    ws.getColumn(1).width = 12;
    ch.series.forEach((s, i) => { ws.getColumn(i + 2).width = Math.max(14, (s.chartLabel || s.id).length + 2); });
  }

  const src = wb.addWorksheet('Sources', { properties: { defaultColWidth: 22 } });
  src.addRow([heading]).font = { name: 'Calibri', size: 12, bold: true };
  src.addRow([]);
  styleHeaderRow(src.addRow(['Chart', 'Source', 'Series', 'Link']));
  for (const ch of charts) {
    for (const it of ch.sources || []) src.addRow([ch.title, it.citation, it.detail || '', it.url || '']);
  }
  [45, 70, 40, 55].forEach((w, i) => { src.getColumn(i + 1).width = w; });
  src.addRow([]);
  src.addRow(['Exported', new Date().toISOString().slice(0, 10)]);
  src.addRow(['App', 'https://housing-economic-data.vercel.app/']);
  src.addRow(['Caveats', 'Public data, see source links for definitions. Verify before relying on for appraisals.']);

  const buf = await wb.xlsx.writeBuffer();
  triggerDownload(new Blob([buf],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

/**
 * Embed captured chart images (from doc-image-export.js) into an .xlsx, one
 * worksheet per chart, named from the chart title. Images are anchored at A1
 * at their on-screen CSS size (the 3x raster keeps them crisp when zoomed).
 * @param {Array<{dataUrl, width, height, title}>} captures
 * @param {Object} opts  { filename }
 */
export async function exportChartsToExcel(captures, { filename }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Housing & Economic Data';
  wb.created = new Date();

  const used = new Set();
  captures.forEach((c, i) => {
    // Excel sheet names: max 31 chars, no \ / ? * [ ] : — and must be unique.
    let base = (c.title || `Chart ${i + 1}`)
      .replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim()
      .slice(0, 28).trim() || `Chart ${i + 1}`;
    let name = base, k = 2;
    while (used.has(name.toLowerCase())) name = `${base} ${k++}`;
    used.add(name.toLowerCase());

    const ws = wb.addWorksheet(name);
    const imgId = wb.addImage({
      base64: c.dataUrl.split(',')[1],
      extension: 'png',
    });
    ws.addImage(imgId, {
      tl: { col: 0, row: 0 },
      ext: { width: c.width, height: c.height },
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  triggerDownload(blob, filename);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
