/*
 * Word (.docx) export for the comparison-tables view. Ported from the retired
 * CMHC-VacancyMedianRents Shiny tool's R/export.R (flextable/officer):
 *   - Calibri 11pt throughout, no fill colours
 *   - Title: Calibri 14pt bold above each table
 *   - Header row: bold, thin dark-red bottom border
 *   - Data rows: no borders; last row gets a medium dark-red bottom border
 *   - Area names left-aligned, values centred; '**' italic grey for missing
 *
 * The docx library is heavy, so this module is only ever loaded via dynamic
 * import from tables.js — same lazy pattern as excel-export.js / ExcelJS.
 */

import {
  AlignmentType, BorderStyle, Document, ImageRun, Packer, Paragraph, Table,
  TableCell, TableRow, TextRun, WidthType,
} from 'docx';

const ACCENT = '8B0000';
const NA_GREY = '95A5A6';
// docx border size is in eighths of a point: 6 = 0.75pt (thin), 12 = 1.5pt (medium).
const BORDER_THIN   = { style: BorderStyle.SINGLE, size: 6,  color: ACCENT };
const BORDER_MEDIUM = { style: BorderStyle.SINGLE, size: 12, color: ACCENT };
const BORDER_NONE   = { style: BorderStyle.NONE,   size: 0,  color: 'auto' };

const run  = (text, opts = {}) =>
  new TextRun({ text, font: 'Calibri', size: 22, ...opts });   // 22 half-points = 11pt

function cell({ text, align, bottom = BORDER_NONE, bold = false, na = false }) {
  return new TableCell({
    borders: { top: BORDER_NONE, left: BORDER_NONE, right: BORDER_NONE, bottom },
    margins: { top: 40, bottom: 40, left: 100, right: 100 },   // twips ≈ 2pt / 5pt
    children: [new Paragraph({
      alignment: align,
      children: [run(text, na ? { italics: true, color: NA_GREY } : { bold })],
    })],
  });
}

function buildDocxTable(table) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      cell({ text: '', align: AlignmentType.LEFT, bottom: BORDER_THIN, bold: true }),
      ...table.columns.map(c =>
        cell({ text: c, align: AlignmentType.CENTER, bottom: BORDER_THIN, bold: true })),
    ],
  });

  const bodyRows = table.rows.map((r, i) => {
    const bottom = i === table.rows.length - 1 ? BORDER_MEDIUM : BORDER_NONE;
    return new TableRow({
      children: [
        cell({ text: r.area, align: AlignmentType.LEFT, bottom }),
        ...r.values.map(v => v == null
          ? cell({ text: '**', align: AlignmentType.CENTER, bottom, na: true })
          : cell({ text: v,    align: AlignmentType.CENTER, bottom })),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: BORDER_NONE, bottom: BORDER_NONE, left: BORDER_NONE, right: BORDER_NONE,
      insideHorizontal: BORDER_NONE, insideVertical: BORDER_NONE,
    },
    rows: [headerRow, ...bodyRows],
  });
}

/**
 * @param {Array} built  list of rendered tables (output of tables.js render)
 * @param {Object} opts  { filename, maxYear }
 */
export async function exportTablesToWord(built, { filename, maxYear }) {
  const children = [];
  built.forEach((table, i) => {
    const title = `${table.title}${table.dwellingSuffix || ''} — CMHC ${maxYear} October`;
    children.push(new Paragraph({
      spacing: { before: i === 0 ? 0 : 240, after: 80 },
      children: [run(title, { bold: true, size: 28 })],          // 14pt
    }));
    children.push(buildDocxTable(table));
  });

  const doc = new Document({
    creator: 'CMHC Charts',
    description: 'CMHC Rental Market Survey comparison tables',
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, filename);
}

/**
 * Embed captured chart images (from doc-image-export.js) into a .docx, one
 * per paragraph in capture order. Images are scaled to the printable width
 * of a Letter page (6.5in = 624px @ 96dpi); the 3x raster keeps them crisp.
 * @param {Array<{dataUrl, width, height}>} captures
 * @param {Object} opts  { filename }
 */
export async function exportChartsToWord(captures, { filename }) {
  const PAGE_W = 624;
  const children = [];
  for (const c of captures) {
    const scale = Math.min(1, PAGE_W / c.width);
    const data = await (await fetch(c.dataUrl)).arrayBuffer();
    children.push(new Paragraph({
      spacing: { after: 240 },
      children: [new ImageRun({
        type: 'png',
        data,
        transformation: {
          width:  Math.round(c.width * scale),
          height: Math.round(c.height * scale),
        },
      })],
    }));
  }

  const doc = new Document({
    creator: 'CMHC Charts',
    description: 'CMHC chart exports',
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
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
