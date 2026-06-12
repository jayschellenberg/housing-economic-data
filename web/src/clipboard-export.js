/*
 * Rich copy-to-clipboard for the comparison-tables view. Ported from the
 * retired CMHC-VacancyMedianRents Shiny tool (www/clipboard.js + R/export.R):
 * tables are copied as inline-styled HTML so pasting into Word preserves the
 * appraisal SampleTables look — Calibri 11pt, 14pt bold titles, thin dark-red
 * border under the header row, medium dark-red border under the last row.
 *
 * A text/plain TSV rendition rides along in the same ClipboardItem so pasting
 * into Excel or a plain-text editor still produces usable rows.
 */

const ACCENT = '#8B0000';
const FONT = 'Calibri, sans-serif';

/**
 * Build Word-compatible HTML for the rendered tables.
 * @param {Array} built  list of rendered tables (output of tables.js render)
 * @param {Object} opts  { maxYear }
 */
export function buildTablesHtml(built, { maxYear }) {
  const parts = built.map(table => {
    const title = `${table.title}${table.dwellingSuffix || ''} — CMHC ${maxYear} October`;
    const th = (text, align) =>
      `<th style="font-family:${FONT};font-size:11pt;font-weight:bold;color:#000;` +
      `border:none;border-bottom:0.75pt solid ${ACCENT};padding:2pt 8pt;text-align:${align};">${escapeHtml(text)}</th>`;
    const td = (text, align, { last = false, na = false } = {}) =>
      `<td style="font-family:${FONT};font-size:11pt;` +
      (na ? 'font-style:italic;color:#95a5a6;' : 'color:#000;') +
      `border:none;${last ? `border-bottom:1.5pt solid ${ACCENT};` : ''}` +
      `padding:2pt 8pt;text-align:${align};">${escapeHtml(text)}</td>`;

    const header = `<tr>${th('', 'left')}${table.columns.map(c => th(c, 'center')).join('')}</tr>`;
    const body = table.rows.map((r, i) => {
      const last = i === table.rows.length - 1;
      const cells = [
        td(r.area, 'left', { last }),
        ...r.values.map(v => v == null
          ? td('**', 'center', { last, na: true })
          : td(v, 'center', { last })),
      ];
      return `<tr>${cells.join('')}</tr>`;
    }).join('');

    return `<p style="font-family:${FONT};font-size:14pt;font-weight:bold;margin:0 0 4pt 0;">${escapeHtml(title)}</p>` +
      `<table style="border-collapse:collapse;border:none;">` +
      `<thead>${header}</thead><tbody>${body}</tbody></table>`;
  });
  return parts.join('<br>');
}

/**
 * Plain-text (TSV) rendition — Excel-pasteable fallback.
 */
export function buildTablesText(built, { maxYear }) {
  return built.map(table => {
    const title = `${table.title}${table.dwellingSuffix || ''} — CMHC ${maxYear} October`;
    const lines = [
      title,
      ['', ...table.columns].join('\t'),
      ...table.rows.map(r =>
        [r.area, ...r.values.map(v => v == null ? '**' : v)].join('\t')),
    ];
    return lines.join('\n');
  }).join('\n\n');
}

/**
 * Copy the rendered tables to the clipboard as rich HTML, with the same
 * fallback chain as the original Shiny tool.
 * @returns {Promise<'success'|'fallback'|'legacy'|'failed'>}
 */
export async function copyTablesToClipboard(built, opts) {
  const html = buildTablesHtml(built, opts);
  const text = buildTablesText(built, opts);

  if (navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return 'success';
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        return 'fallback';
      } catch { /* fall through to legacy path */ }
    }
  }

  // Legacy fallback: select a hidden node and execCommand('copy').
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.style.position = 'fixed';
  tmp.style.left = '-9999px';
  document.body.appendChild(tmp);
  const range = document.createRange();
  range.selectNodeContents(tmp);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  let status = 'failed';
  try {
    if (document.execCommand('copy')) status = 'legacy';
  } catch { /* keep 'failed' */ }
  tmp.remove();
  sel.removeAllRanges();
  return status;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
