/*
 * Chart cards for the framed dashboards (web/rental/, web/commercial/).
 *
 * The Rental and Commercial dashboards drew bare Observable Plot figures
 * with a small grey heading. Every other chart on the site sits in a chart
 * card: maroon title, subtitle, framed plot with a dashed grid, the legend
 * under the plot, a caption row signed with the Company name from the site
 * header, and a Download PNG that comes out at 1950 × 1050 @ 300 DPI. This
 * module gives the dashboards the same card, reusing the site's plot theme
 * (plot-theme.js), the fixed-size PNG export (png-export.js) and the
 * company-name pref (firm.js).
 *
 * Import it lazily (it pulls in Plot): the dashboards load it with Plot on
 * the first open of their Analysis tab. Styles: lib/subapp-house.css.
 *
 * The Company box lives in the parent page's header, a different document.
 * Both read the same localStorage pref (same origin), and a change made up
 * there reaches this frame as a `storage` event, so the caption follows it
 * live just as the site's own cards do.
 */

import * as Plot from '@observablehq/plot';
import { themed, gridMarks, frameMark } from './plot-theme.js';
import { setExportRedraw, downloadCardPng } from './png-export.js';
import { getFirm } from './firm.js';
import { exportChartNodes } from './doc-image-export.js';

export { Plot, gridMarks, frameMark };

const PREFS_KEY = 'hed:prefs';   // prefs.js
const cards = new Set();

window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== PREFS_KEY) return;
  for (const c of cards) c.applyFirm();
});

/**
 * Append a chart card to `host`.
 *
 * @param {Element} host
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.fileStem   PNG filename stem
 * @param {number} [opts.height]   on-screen plot height
 * @returns {{ card: Element, render: Function }}
 *   render({ subtitle, source, legend, note, empty, spec }):
 *     spec(width) → Plot options (marks, x, y, …) — merged into the site
 *     theme; the card sets width and height. Pass `empty` (a message)
 *     instead of `spec` when there is nothing to plot. `legend` is
 *     [{ label, color }], drawn under the plot as on the site's cards.
 */
export function buildPlotCard(host, { title, fileStem, height = 280 }) {
  const card = document.createElement('section');
  card.className = 'chart-card';
  card.innerHTML = `
    <header class="chart-title"></header>
    <p class="chart-sub" data-role="sub"></p>
    <div data-role="plot"></div>
    <p class="chart-empty" data-role="empty" hidden></p>
    <div class="cmhc-plot-legend" data-role="legend" hidden></div>
    <p class="chart-note" data-role="note" hidden></p>
    <div class="chart-caption">
      <span data-role="firm"></span>
      <span class="chart-source" data-role="source"></span>
    </div>
    <div class="chart-actions">
      <button type="button" data-role="png">Download PNG</button>
    </div>`;
  card.querySelector('.chart-title').textContent = title;
  host.appendChild(card);

  const $ = (role) => card.querySelector(`[data-role="${role}"]`);
  const $plot = $('plot');
  const $caption = card.querySelector('.chart-caption');
  let spec = null;
  let lastW = 0;

  function applyFirm() {
    const firm = getFirm();
    $('firm').textContent = firm;
    $caption.hidden = !firm && !$('source').textContent;
  }

  /** Draw at the card's current width; `h` overrides the height (PNG export). */
  function draw(h) {
    $plot.replaceChildren();
    if (!spec) return;
    const width = Math.max(280, Math.round($plot.clientWidth || 600));
    if (h == null) lastW = width;
    const s = spec(width);
    $plot.appendChild(Plot.plot(themed({
      ...s,
      width,
      height: h ?? height,
      marks: [...gridMarks(), ...(s.marks || []), frameMark()],
      // The legend is HTML under the plot, as on the site's cards.
      color: { ...(s.color || {}), legend: false },
    })));
  }
  setExportRedraw(card, draw);

  // Redraw when the card changes width (window resize, sidebar collapse) —
  // never mid-capture, when png-export has pinned it to 750 px on purpose.
  new ResizeObserver(() => {
    if (!spec || card.classList.contains('cmhc-exporting')) return;
    if (Math.abs(Math.round($plot.clientWidth) - lastW) > 8) draw();
  }).observe(card);

  $('png').addEventListener('click', async () => {
    const date = new Date().toISOString().slice(0, 10);
    try {
      await downloadCardPng(card, `${fileStem}_${date}.png`, {
        filter: (n) => !(n.classList && (n.classList.contains('chart-actions') || n.classList.contains('chart-note'))),
      });
    } catch (err) { console.error('[chart card export]', err); }
  });

  function render({ subtitle = '', source = '', legend = [], note = '', empty = '', spec: next = null } = {}) {
    $('sub').textContent = subtitle;
    $('source').textContent = source ? `Source: ${source}` : '';
    const $empty = $('empty');
    $empty.textContent = empty;
    $empty.hidden = !empty;
    const $legend = $('legend');
    $legend.replaceChildren(...legend.map(({ label, color }) => {
      const item = document.createElement('span');
      item.className = 'cmhc-plot-legend-item';
      const sw = document.createElement('span');
      sw.className = 'cmhc-plot-legend-swatch';
      sw.style.background = color;
      const text = document.createElement('span');
      text.textContent = label;
      item.append(sw, text);
      return item;
    }));
    $legend.hidden = !legend.length || !next;
    const $note = $('note');
    $note.textContent = note;
    $note.hidden = !note;
    spec = empty ? null : next;
    applyFirm();
    draw();
  }

  const entry = { applyFirm };
  cards.add(entry);
  return { card, render };
}

/** The Word / Excel chart downloads, for a dashboard's sidebar buttons. */
export function exportCards(btn, kind, nodes, baseName) {
  return exportChartNodes(btn, kind, nodes, { baseName });
}
