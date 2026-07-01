/*
 * Lightweight per-browser preferences (localStorage). The site is a static app
 * with no accounts or backend, so these are per-device, not per-user-login.
 *
 * Used so a returning visitor lands on the province / area they last looked at
 * instead of the built-in Manitoba default. `province` is a shared key every
 * province-scoped tab reads/writes to honour a chosen "home" province; other
 * keys are tab-specific (e.g. `affArea`). Wrapped in try/catch so private-mode /
 * disabled storage degrades to the defaults rather than throwing.
 *
 * Currently the default province is *implicit* — it simply tracks the last
 * province you viewed. If an *explicit* "set as my default province" control is
 * wanted later, it would just call setPref('province', code) from a settings UI;
 * the resolveProvince() consumers below need no change.
 */

const KEY = 'hed:prefs';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch { return {}; }
}
function write(obj) {
  try { localStorage.setItem(KEY, JSON.stringify(obj)); }
  catch { /* storage unavailable — preferences just won't persist */ }
}

export function getPref(key) {
  const v = read()[key];
  return v == null ? null : v;
}
export function setPref(key, value) {
  const obj = read();
  obj[key] = value;
  write(obj);
}

/**
 * Shared "home province" helpers used by every province-scoped tab.
 * resolveProvince() returns the saved province if it's one this tab offers,
 * else `fallback` (Manitoba by default). rememberProvince() records a choice —
 * only 2-digit SGC province codes (46/47/48/59), never 'CA'/other scopes.
 */
export function resolveProvince(available, fallback = '46') {
  const saved = getPref('province');
  return (saved && available.includes(saved)) ? saved : fallback;
}
export function rememberProvince(code) {
  if (/^\d{2}$/.test(String(code))) setPref('province', String(code));
}
