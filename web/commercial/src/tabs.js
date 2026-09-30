/*
 * tabs.js — Map & listings (Explore) · Summary · Analysis.
 *
 * The page used to stack the connect card, the overview, the filters,
 * the map and the grid in one column, so the first thing on screen after
 * connecting was a row of summary tiles and the map was a scroll away.
 * Explore — filters, map, grid — is now what a connected folder lands on.
 *
 * Before a folder is connected there are no tabs at all: the connect
 * controls are in the sidebar (as on every Local Data tab) and the main
 * area shows only the #empty-state line.
 *
 * The view is part of the link: #listings / #summary / #analysis (Explore
 * is "listings" in a link, the name Rental uses for the same view). Inside
 * the site's Local Data tab the parent page is told as well, so its address
 * bar reads #commercial/summary and a copied link reopens this view. A link's
 * view wins; otherwise the last tab is remembered per browser as a
 * convenience only. Storage can be missing or refuse (a private window,
 * blocked site data), and the page must behave the same without it.
 */

const $ = (id) => document.getElementById(id);
const TAB_KEY = 'commavail_tab';
const PANELS = Object.freeze({
  explore: 'explore',
  summary: 'panel-summary',
  analysis: 'analysis',
});
const DEFAULT_TAB = 'explore';
const TO_LINK = { explore: 'listings', summary: 'summary', analysis: 'analysis' };
const FROM_LINK = { listings: 'explore', summary: 'summary', analysis: 'analysis' };

function remembered() {
  const fromLink = FROM_LINK[window.location.hash.replace('#', '')];
  if (fromLink) return fromLink;
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v && PANELS[v] ? v : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

function reportView(tab) {
  const view = TO_LINK[tab];
  try { history.replaceState(null, '', `#${view}`); } catch { /* convenience only */ }
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'hed:subview', app: 'commercial', view }, window.location.origin);
  }
}

export function initTabs({ onChange } = {}) {
  const $nav = $('tabs');
  if (!$nav) return { setConnected() {}, show() {}, current: () => DEFAULT_TAB };

  const buttons = [...$nav.querySelectorAll('[data-tab]')];
  let current = remembered();
  let connected = false;

  function paint() {
    $nav.hidden = !connected;
    for (const b of buttons) {
      const on = connected && b.dataset.tab === current;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('active', on);
    }
    for (const [tab, id] of Object.entries(PANELS)) {
      const el = $(id);
      if (el) el.hidden = !connected || tab !== current;
    }
    const $empty = $('empty-state');
    if ($empty) $empty.hidden = connected;
    reportView(current);
  }

  function show(tab, { focus = false } = {}) {
    if (!PANELS[tab]) return;
    const changed = tab !== current;
    current = tab;
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* convenience only */ }
    paint();
    if (focus) buttons.find((b) => b.dataset.tab === tab)?.focus();
    if (changed || focus) onChange?.(tab);
  }

  $nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) show(b.dataset.tab);
  });

  // The WAI-ARIA tab pattern: arrows move between tabs, Home/End jump.
  $nav.addEventListener('keydown', (e) => {
    const i = buttons.findIndex((b) => b.dataset.tab === current);
    let next = null;
    if (e.key === 'ArrowRight') next = buttons[(i + 1) % buttons.length];
    else if (e.key === 'ArrowLeft') next = buttons[(i - 1 + buttons.length) % buttons.length];
    else if (e.key === 'Home') next = buttons[0];
    else if (e.key === 'End') next = buttons[buttons.length - 1];
    if (!next) return;
    e.preventDefault();
    show(next.dataset.tab, { focus: true });
  });

  paint();

  return {
    /** A folder was connected (true) or disconnected (false). */
    setConnected(on) {
      const was = connected;
      connected = Boolean(on);
      paint();
      if (connected && !was) onChange?.(current);
    },
    show,
    current: () => current,
  };
}
