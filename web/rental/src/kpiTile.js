/*
 * kpi-tile.js — a headline tile in the Current Snapshot tab's KPI card style
 * (.cmhc-kpi, styled by ../src/lib/subapp-house.css): uppercase label, bold
 * value, grey detail lines, optional neutral comparison chips. Used by the
 * Rental and Commercial dashboards so their headline numbers read like the
 * rest of the site's. Pure DOM, text only (no HTML from data).
 */

/**
 * @param {Object} t
 * @param {string} t.label
 * @param {string} t.value
 * @param {string[]} [t.meta]     detail lines under the value
 * @param {Array<{window:string,text:string}>} [t.chips]  comparison chips
 * @param {string} [t.color]      series colour dot beside the label
 * @param {string} [t.tag]        element to build ('div' or 'li')
 * @returns {HTMLElement}
 */
export function kpiTile({ label, value, meta = [], chips = [], color, tag = 'div' }) {
  const tile = document.createElement(tag);
  tile.className = 'cmhc-kpi';
  const $label = document.createElement('div');
  $label.className = 'cmhc-kpi-label';
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'cmhc-kpi-swatch';
    dot.style.background = color;
    $label.appendChild(dot);
  }
  $label.appendChild(document.createTextNode(label));
  const $value = document.createElement('div');
  $value.className = 'cmhc-kpi-value';
  $value.textContent = value;
  tile.append($label, $value);
  for (const line of meta.filter(Boolean)) {
    const m = document.createElement('div');
    m.className = 'cmhc-kpi-meta';
    m.textContent = line;
    tile.appendChild(m);
  }
  if (chips.length) {
    const wrap = document.createElement('div');
    wrap.className = 'cmhc-kpi-deltas';
    for (const c of chips) {
      const chip = document.createElement('span');
      chip.className = 'cmhc-kpi-delta';
      const w = document.createElement('span');
      w.className = 'cmhc-kpi-delta-window';
      w.textContent = c.window;
      chip.append(w, document.createTextNode(` ${c.text}`));
      wrap.appendChild(chip);
    }
    tile.appendChild(wrap);
  }
  return tile;
}
