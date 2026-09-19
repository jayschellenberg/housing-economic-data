/*
 * The company name that signs every indicator chart.
 *
 * The reference appraisal chart carries the firm's name under the figure, and
 * that is what the caption row of an indicator card is for: the source moved
 * up into the subtitle, so the caption is free to say whose work the figure
 * belongs to. A chart pasted into a report should be attributable on sight.
 *
 * It lives in the shared per-browser prefs (prefs.js) because it is a property
 * of whoever is using the site, not of any one tab. The header box is the only
 * place it is set; every open card follows a change to it live, via a window
 * event rather than a re-render, and the saved value is read back on the next
 * visit so the name only has to be typed once.
 */

import { getPref, setPref } from './prefs.js';

const FIRM_PREF = 'firmName';
const FIRM_EVENT = 'hed:firm';

/**
 * Nobody's name until someone types their own.
 *
 * This shipped seeded with the firm the Cap vs Interest section was built for,
 * which was harmless while the box lived in that one section. Now that the
 * field is in the header and signs every chart on the site, a stranger's name
 * would go out under the figures of anyone who never opened the box — so the
 * box starts empty and the charts stay unsigned until the name is set.
 */
export const DEFAULT_FIRM = '';

/** The saved company name, or empty when nothing has been saved. */
export function getFirm() {
  const saved = getPref(FIRM_PREF);
  return (saved == null ? DEFAULT_FIRM : String(saved)).trim();
}

/**
 * Save a company name and tell every listening card. Saved as typed, on each
 * keystroke, so the name is on the chart before the PNG is downloaded and is
 * still there the next time this browser opens the site. An empty string is a
 * real choice — "don't sign my charts" — not an absent one.
 */
export function setFirm(name) {
  const value = String(name ?? '').trim();
  setPref(FIRM_PREF, value);
  window.dispatchEvent(new CustomEvent(FIRM_EVENT, { detail: value }));
}

/**
 * Call `cb(name)` whenever the company name changes.
 * @returns {Function} unsubscribe
 */
export function onFirmChange(cb) {
  const handler = (e) => cb(typeof e.detail === 'string' ? e.detail : getFirm());
  window.addEventListener(FIRM_EVENT, handler);
  return () => window.removeEventListener(FIRM_EVENT, handler);
}
