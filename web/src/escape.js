/*
 * Shared HTML-escaping helper for innerHTML sinks.
 *
 * Several view modules historically defined their own identical copy of this
 * function; chart.js / indicator-chart.js / indicators.js had none, which is
 * how a few `${title}`/`${label}` sinks slipped through unescaped. New or
 * previously-overlooked sinks should import this one so escaping stays
 * consistent across the app. Safe to interpolate into both element text and
 * double-quoted attribute values (escapes & < > " ').
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
