/*
 * Shared chart-image capture for the per-tab "Download Word / Excel" buttons.
 * Renders each chart card to a high-res PNG data URL via html-to-image, using
 * the same exclusion filter as the per-card PNG downloads (chart.js /
 * indicator-chart.js): the actions row, stale-data banner, and explainer are
 * on-screen helpers, not part of the chart someone embeds in a report.
 */

import { toPng } from 'html-to-image';

const EXPORT_FILTER = (n) => !(n.classList && (
  n.classList.contains('chart-actions') ||
  n.classList.contains('cmhc-stale-warning') ||
  n.classList.contains('cmhc-explainer')));

/**
 * Capture DOM nodes as PNGs, sequentially (html-to-image is not re-entrant
 * on shared webfont caches).
 * @param {Element[]} nodes
 * @returns {Promise<Array<{dataUrl, width, height, title}>>}
 *          width/height are CSS pixels; the PNG is rasterised at 3x for
 *          print resolution, so embed at the CSS size.
 */
export async function captureNodes(nodes, { pixelRatio = 3 } = {}) {
  const captures = [];
  // skipFonts: true short-circuits html-to-image's per-node attempt to read
  // and embed @font-face rules from the Google Fonts stylesheet. The fetch
  // fails on every iteration due to CORS, costs ~3 sec per chart, and the
  // exported PNG falls back to system Calibri either way — which is what
  // the appraisal export template uses, so the visual result is unchanged.
  for (const node of nodes) {
    node.classList.add('cmhc-exporting');
    try {
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
        title:  node.querySelector('.chart-title')?.textContent?.trim()
             || node.querySelector('.cmhc-kpi-label')?.textContent?.trim()
             || node.querySelector('.cmhc-snapshot-title')?.textContent?.trim()
             || `Chart ${captures.length + 1}`,
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
 * @param {number} [opts.pixelRatio]  optional override (default 3)
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
          await exportChartsToWord(captures, { filename: `CMHC_${baseName}_${date}.docx` });
        } else {
          const { exportChartsToExcel } = await import('./excel-export.js');
          await exportChartsToExcel(captures, { filename: `CMHC_${baseName}_${date}.xlsx` });
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
