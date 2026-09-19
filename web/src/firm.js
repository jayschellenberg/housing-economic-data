/*
 * The company name that signs every indicator chart.
 *
 * The reference appraisal chart carries the firm's name under the figure, and
 * that is what the caption row of an indicator card is for: the source moved
 * up into the subtitle, so the caption is free to say whose work the figure
 * belongs to. A chart pasted into a report should be attributable on sight.
 *
 * It lives in the shared per-browser prefs (prefs.js) because it is a property
 * of whoever is using the site, not of any one tab — the header box and the
 * Cap vs Interest box are two views of the same value, and every open card
 * follows a change to it live, via a window event rather than a re-render.
 */

import { getPref, setPref } from './prefs.js';

const FIRM_PREF = 'firmName';
const FIRM_EVENT = 'hed:firm';

/**
 * Shown until someone types their own. The Cap vs Interest section shipped
 * with this default, so keeping it means the value (and its saved pref) reads
 * the same as it did before the caption went site-wide.
 */
export const DEFAULT_FIRM = 'Red River Group';

/** The saved company name, or the default when nothing has been saved. */
export function getFirm() {
  const saved = getPref(FIRM_PREF);
  return (saved == null ? DEFAULT_FIRM : String(saved)).trim();
}

/**
 * Save a company name and tell every listening card. An empty string is a
 * real choice — it means "don't sign my charts" — so it is stored as typed
 * rather than falling back to the default.
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
