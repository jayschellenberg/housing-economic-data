/*
 * exports.js — report-ready renditions of a set of listings: the
 * criteria text that documents how the set was chosen, the Word table
 * (inline-styled HTML + TSV fallback, same look as the housing site's
 * copy-to-Word), and the typed rows the XLSX writer lays out.
 *
 * Pure: no DOM, no clipboard, no exceljs — those live in ../exports.js.
 */

import { COLUMNS, EXPORT_FIELDS } from './results.js';
import {
  TYPES, TYPE_LABELS, BEDROOM_BANDS, UNASSIGNED, additionalChips, resolveWindow, rentPerSqft,
} from './filters.js';

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Columns that go into the Word table, in order (keys from results.COLUMNS). */
export const REPORT_KEYS = Object.freeze([
  'address', 'muni', 'area', 'type', 'beds', 'baths', 'sqft', 'rent', 'psf', 'dist', 'last_seen', 'source',
]);

const byKey = new Map(COLUMNS.map((c) => [c.key, c]));

/**
 * The selection criteria in words — one line per active filter — so a
 * pasted comp table carries its own provenance.
 * @param {Object} f       filter state
 * @param {Object} ctx     { asOf, policy }
 */
export function describeFilters(f, { asOf, policy } = {}) {
  const lines = [];
  const win = resolveWindow(f, { asOf, activeWindowDays: policy?.active_window_days ?? 60 });
  switch (f.window) {
    case 'active':
      lines.push(`Active listings as of ${asOf || 'the latest scrape'} (seen within ${policy?.active_window_days ?? 60} days)`);
      break;
    case '3': case '6': case '12':
      lines.push(`Listings observed in the ${f.window} months to ${asOf || 'the latest scrape'} (from ${win.from})`);
      break;
    case 'custom':
      lines.push(`Listings observed ${win.from ? `from ${win.from}` : ''}${win.from && win.to ? ' ' : ''}${win.to ? `to ${win.to}` : ''}`.trim() || 'All observations');
      break;
    default:
      lines.push('All observations since scraping began');
  }
  const allTypes = f.types.length === 0 || TYPES.every((t) => f.types.includes(t));
  if (!allTypes) lines.push(`Type: ${f.types.map((t) => TYPE_LABELS[t] || t).join(', ')}`);
  const allBeds = f.beds.length === 0 || BEDROOM_BANDS.every((b) => f.beds.includes(b.key));
  if (!allBeds) {
    const label = (k) => (BEDROOM_BANDS.find((b) => b.key === k)?.label || k);
    lines.push(`Bedrooms: ${f.beds.map((k) => (label(k) === 'Studio' ? 'Studio' : `${label(k)} BR`)).join(', ')}`);
  }
  if (f.munis.length) {
    lines.push(`Municipality: ${f.munis.map((m) => (m === UNASSIGNED ? 'unassigned' : m)).join(', ')}`
      + (f.adjacent ? ' (plus adjacent municipalities)' : ''));
  }
  if (f.nbhds.length) lines.push(`Winnipeg neighbourhood: ${f.nbhds.join(', ')}`);
  if (f.mls.length) lines.push(`MLS area: ${f.mls.join(', ')}`);
  if (f.sources.length) lines.push(`Source: ${f.sources.join(', ')}`);
  const money = (v) => `$${Number(v).toLocaleString('en-CA')}`;
  if (f.rentLo !== '' && f.rentHi !== '') lines.push(`Rent ${money(f.rentLo)}–${money(f.rentHi)}`);
  else if (f.rentLo !== '') lines.push(`Rent ≥ ${money(f.rentLo)}`);
  else if (f.rentHi !== '') lines.push(`Rent ≤ ${money(f.rentHi)}`);
  if (f.canonicalOnly) lines.push('One row per unit (cross-source duplicates removed)');
  const chips = additionalChips(f);
  if (chips.length) lines.push(chips.map((c) => c.label).join('; '));
  return lines;
}

// ---- Word ---------------------------------------------------------------------

const FONT = 'Calibri, sans-serif';
const ACCENT = '#8B0000';

/**
 * Inline-styled HTML for the clipboard: a bold title, the criteria as a
 * small paragraph, then the table. Word keeps inline styles; class-based
 * CSS is dropped, which is why every cell restates its font.
 */
export function buildWordHtml(rows, { title = 'Rental listings', criteria = [], note = '' } = {}) {
  const cols = REPORT_KEYS.map((k) => byKey.get(k)).filter(Boolean);
  const th = (text, align) =>
    `<th style="font-family:${FONT};font-size:10pt;font-weight:bold;color:#000;border:none;` +
    `border-bottom:0.75pt solid ${ACCENT};padding:2pt 6pt;text-align:${align};white-space:nowrap;">${escapeHtml(text)}</th>`;
  const td = (text, align, last) =>
    `<td style="font-family:${FONT};font-size:10pt;color:#000;border:none;` +
    `${last ? `border-bottom:1.5pt solid ${ACCENT};` : ''}padding:2pt 6pt;text-align:${align};white-space:nowrap;">${escapeHtml(text)}</td>`;
  const header = `<tr>${cols.map((c) => th(c.label, c.num ? 'right' : 'left')).join('')}</tr>`;
  const body = rows.map((l, i) => {
    const last = i === rows.length - 1;
    return `<tr>${cols.map((c) => td(c.text(l), c.num ? 'right' : 'left', last)).join('')}</tr>`;
  }).join('');
  const crit = criteria.length
    ? `<p style="font-family:${FONT};font-size:9pt;color:#444;margin:0 0 4pt 0;">${criteria.map(escapeHtml).join('<br>')}</p>`
    : '';
  const foot = note ? `<p style="font-family:${FONT};font-size:8pt;color:#666;margin:4pt 0 0 0;">${escapeHtml(note)}</p>` : '';
  return `<p style="font-family:${FONT};font-size:12pt;font-weight:bold;margin:0 0 2pt 0;">${escapeHtml(title)}</p>`
    + crit
    + `<table style="border-collapse:collapse;border:none;"><thead>${header}</thead><tbody>${body}</tbody></table>`
    + foot;
}

/** TSV twin of buildWordHtml, for Excel / plain-text pastes. */
export function buildWordText(rows, { title = 'Rental listings', criteria = [], note = '' } = {}) {
  const cols = REPORT_KEYS.map((k) => byKey.get(k)).filter(Boolean);
  const lines = [title, ...criteria, cols.map((c) => c.label).join('\t')];
  for (const l of rows) lines.push(cols.map((c) => c.text(l)).join('\t'));
  if (note) lines.push(note);
  return lines.join('\n');
}

/**
 * Generic Word-styled table (the analysis tables): `cols` are header
 * strings, `body` rows of cell strings; every column after the first is
 * right-aligned.
 */
export function tableWordHtml(cols, body, { title = '', criteria = [], note = '' } = {}) {
  const th = (text, align) =>
    `<th style="font-family:${FONT};font-size:10pt;font-weight:bold;color:#000;border:none;` +
    `border-bottom:0.75pt solid ${ACCENT};padding:2pt 6pt;text-align:${align};white-space:nowrap;">${escapeHtml(text)}</th>`;
  const td = (text, align, last) =>
    `<td style="font-family:${FONT};font-size:10pt;color:#000;border:none;` +
    `${last ? `border-bottom:1.5pt solid ${ACCENT};` : ''}padding:2pt 6pt;text-align:${align};white-space:nowrap;">${escapeHtml(text)}</td>`;
  const header = `<tr>${cols.map((c, i) => th(c, i ? 'right' : 'left')).join('')}</tr>`;
  const rowsHtml = body.map((r, i) => `<tr>${r.map((c, j) => td(c, j ? 'right' : 'left', i === body.length - 1)).join('')}</tr>`).join('');
  const crit = criteria.length ? `<p style="font-family:${FONT};font-size:9pt;color:#444;margin:0 0 4pt 0;">${criteria.map(escapeHtml).join('<br>')}</p>` : '';
  const foot = note ? `<p style="font-family:${FONT};font-size:8pt;color:#666;margin:4pt 0 0 0;">${escapeHtml(note)}</p>` : '';
  return (title ? `<p style="font-family:${FONT};font-size:12pt;font-weight:bold;margin:0 0 2pt 0;">${escapeHtml(title)}</p>` : '')
    + crit + `<table style="border-collapse:collapse;border:none;"><thead>${header}</thead><tbody>${rowsHtml}</tbody></table>` + foot;
}

/** CSV (UTF-8 BOM, CRLF) of a generic cols/body table — display strings as-is. */
export function tableCsv(cols, body) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols, ...body].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function tableWordText(cols, body, { title = '', criteria = [], note = '' } = {}) {
  const lines = [title, ...criteria, cols.join('\t'), ...body.map((r) => r.join('\t'))].filter((l, i) => i !== 0 || l);
  if (note) lines.push(note);
  return lines.join('\n');
}

// ---- XLSX ---------------------------------------------------------------------

const YES_NO = (v) => (v === true ? 'Yes' : v === false ? 'No' : null);
const BOOL_FIELDS = new Set([
  'parking_included', 'elevator', 'furnished', 'util_heat', 'util_water', 'util_electricity',
  'util_internet', 'util_cable', 'dedup_canonical', 'cited_in_report',
]);

/** Excel number formats per field; anything else is written as-is. */
export const XLSX_FORMATS = Object.freeze({
  rent: '"$"#,##0', rent_psf: '"$"0.00', distance_km: '0.0', sqft: '#,##0', lat: '0.00000', lng: '0.00000',
  bedrooms: '0.#', bathrooms: '0.#', parking_rate: '"$"#,##0',
});

/**
 * Typed rows for the Listings sheet: numbers stay numbers, booleans read
 * Yes/No, null is an empty cell. Same field order as the CSV.
 */
export function xlsxRows(rows) {
  const header = EXPORT_FIELDS.slice();
  const out = rows.map((l) => header.map((k) => {
    if (k === 'rent_psf') return rentPerSqft(l);
    if (k === 'distance_km') return l._dist ?? null;
    if (k === 'sqft') return l.sqft > 0 ? l.sqft : null;
    const v = l[k];
    if (BOOL_FIELDS.has(k)) return YES_NO(v);
    return v ?? null;
  }));
  return { header, rows: out };
}
