/*
 * Shared chart-image capture for the per-tab "Download Word / Excel" buttons.
 * Renders each chart card to a 1950 × 1050, 300 DPI PNG data URL, using
 * the same exclusion filter as the per-card PNG downloads (chart.js /
 * indicator-chart.js): the actions row, stale-data banner, and explainer are
 * on-screen helpers, not part of the chart someone embeds in a report.
 */

import { toPng } from 'html-to-image';
import { CHART_EXPORT_FILTER } from './indicator-chart.js';
import { captureCard, canvasToPngBlob, EXPORT_W, EXPORT_H, EXPORT_DPI } from './png-export.js';

// The per-tab Word/Excel chart exports capture the same shape as the
// single-card PNG button, so they share its filter. (It also drops the
// collapsible data table, which these cards render closed anyway.)
const EXPORT_FILTER = CHART_EXPORT_FILTER;

/** Display size of a fixed-size chart image at 96 DPI: 6.5 × 3.5 in → 624 × 336. */
const FIXED_DISPLAY_W = Math.round(EXPORT_W / EXPORT_DPI * 96);
const FIXED_DISPLAY_H = Math.round(EXPORT_H / EXPORT_DPI * 96);

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const nodeTitle = (node, i) =>
     node.querySelector('.chart-title')?.textContent?.trim()
  || node.querySelector('.cmhc-kpi-label')?.textContent?.trim()
  || node.querySelector('.cmhc-snapshot-title')?.textContent?.trim()
  || `Chart ${i + 1}`;

/**
 * Capture DOM nodes as PNGs, sequentially (html-to-image is not re-entrant
 * on shared webfont caches).
 *
 * By default each node is a chart card and comes out as the site's standard
 * 1950 × 1050, 300 DPI chart image (png-export.js). Pass `pixelRatio` for
 * non-chart nodes (the Snapshot KPI tiles) to capture them at their own
 * on-screen size instead.
 *
 * @param {Element[]} nodes
 * @param {Object} [opts]
 * @param {number} [opts.pixelRatio]  capture at natural size × this ratio
 * @returns {Promise<Array<{dataUrl, width, height, title}>>}
 *          width/height are the display size in CSS (96 DPI) pixels.
 */
export async function captureNodes(nodes, { pixelRatio } = {}) {
  const captures = [];
  for (const node of nodes) {
    if (!pixelRatio) {
      const canvas = await captureCard(node, { filter: EXPORT_FILTER });
      captures.push({
        dataUrl: await blobToDataUrl(await canvasToPngBlob(canvas)),
        width:  FIXED_DISPLAY_W,
        height: FIXED_DISPLAY_H,
        title:  nodeTitle(node, captures.length),
      });
      continue;
    }
    node.classList.add('cmhc-exporting');
    try {
      // skipFonts: reading the cross-origin Google Fonts stylesheet fails on
      // CORS, costs ~3 sec per node, and falls back to system fonts anyway.
      const dataUrl = await toPng(node, {
        backgroundColor: '#ffffff',
        pixelRatio,
        cacheBust: true,
        skipFonts: true,
        filter: EXPORT_FILTER,
      });
      captures.push({
        dataUrl,
        width:  node.offsetWidth,
        height: node.offsetHeight,
        title:  nodeTitle(node, captures.length),
      });
    } finally {
      node.classList.remove('cmhc-exporting');
    }
  }
  return captures;
}

/**
 * Wire one tab's Word + Excel chart-image export buttons.
 * @param {Object} opts
 * @param {string} opts.docxBtnId   button id for the Word download
 * @param {string} opts.xlsxBtnId   button id for the Excel download
 * @param {Function} opts.getNodes  () => Element[] — the tab's chart nodes
 * @param {string} opts.baseName    filename stem, e.g. 'RentalCharts'
 * @param {number} [opts.pixelRatio]  capture non-chart nodes at natural size × this
 *                                    (default: the fixed 1950 × 1050 chart image)
 */
export function wireChartDocExports({ docxBtnId, xlsxBtnId, getNodes, baseName, pixelRatio }) {
  const wire = (btn, kind) => {
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const nodes = getNodes().filter(n => n.offsetParent !== null);
      if (!nodes.length) return;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Preparing…';
      try {
        const captures = await captureNodes(nodes, pixelRatio ? { pixelRatio } : undefined);
        const date = new Date().toISOString().slice(0, 10);
        if (kind === 'docx') {
          const { exportChartsToWord } = await import('./word-export.js');
          await exportChartsToWord(captures, { filename: `${baseName}_${date}.docx` });
        } else {
          const { exportChartsToExcel } = await import('./excel-export.js');
          await exportChartsToExcel(captures, { filename: `${baseName}_${date}.xlsx` });
        }
      } catch (err) {
        console.error(`[${baseName} ${kind} export]`, err);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  };
  wire(document.getElementById(docxBtnId), 'docx');
  wire(document.getElementById(xlsxBtnId), 'xlsx');
}
