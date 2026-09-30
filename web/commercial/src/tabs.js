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
 * The last tab is remembered per browser as a convenience only. Storage
 * can be missing or refuse (a private window, blocked site data), and the
 * page must behave the same without it.
 */

const $ = (id) => document.getElementById(id);
const TAB_KEY = 'commavail_tab';
const PANELS = Object.freeze({
  explore: 'explore',
  summary: 'panel-summary',
  analysis: 'analysis',
});
const DEFAULT_TAB = 'explore';

function remembered() {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v && PANELS[v] ? v : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
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
