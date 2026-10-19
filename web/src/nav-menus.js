/*
 * nav-menus.js — the category menus that hold each group's tabs (Rental /
 * Housing; Multifamily / Commercial). Economy & People tabs sit on the bar.
 *
 * A menu is a disclosure: its trigger button shows and hides a panel of the
 * group's ordinary tab buttons (tab-btn-*), which setupTabs in main.js still
 * wires and activates. This module only opens and closes panels, handles the
 * keyboard, and labels each trigger with the tab open under it.
 *
 * Keyboard: Enter / Space / ↓ on a trigger opens it and focuses the open tab
 * (or the first); ↑ / ↓ / Home / End move through the items; Esc closes and
 * returns to the trigger; ← / → move between triggers in the bar. Tabbing out
 * or clicking anywhere else closes the panel.
 */

let menus = [];

const visibleItems = (m) => [...m.panel.querySelectorAll('.cmhc-menu-item')].filter((b) => !b.hidden);

function isOpen(m) { return !m.panel.hidden; }

function close(m, { focusTrigger = false } = {}) {
  if (!isOpen(m)) return;
  m.panel.hidden = true;
  m.trigger.setAttribute('aria-expanded', 'false');
  if (focusTrigger) m.trigger.focus();
}

function closeAll(except = null) {
  for (const m of menus) if (m !== except) close(m);
}

function open(m, { focus = null } = {}) {
  closeAll(m);
  m.panel.hidden = false;
  m.trigger.setAttribute('aria-expanded', 'true');
  if (!focus) return;
  const items = visibleItems(m);
  const target = focus === 'last' ? items[items.length - 1]
    : items.find((b) => b.classList.contains('cmhc-tab-active')) || items[0];
  target?.focus();
}

function moveFocus(m, step) {
  const items = visibleItems(m);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = step === 'first' ? 0
    : step === 'last' ? items.length - 1
      : (i + step + items.length) % items.length;
  items[next].focus();
}

function siblingTrigger(m, step) {
  const bar = menus.filter((x) => x.bar === m.bar);
  const i = bar.indexOf(m);
  return bar[(i + step + bar.length) % bar.length];
}

function wire(m) {
  m.trigger.addEventListener('click', () => (isOpen(m) ? close(m) : open(m)));
  m.trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(m, { focus: 'active' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open(m, { focus: 'last' }); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      close(m);
      siblingTrigger(m, e.key === 'ArrowRight' ? 1 : -1).trigger.focus();
    } else if (e.key === 'Escape') close(m);
  });
  m.panel.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(m, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(m, -1); }
    else if (e.key === 'Home') { e.preventDefault(); moveFocus(m, 'first'); }
    else if (e.key === 'End') { e.preventDefault(); moveFocus(m, 'last'); }
    else if (e.key === 'Escape') { e.preventDefault(); close(m, { focusTrigger: true }); }
  });
  // Picking a tab closes the menu; main.js's own click handler activates it.
  m.panel.addEventListener('click', (e) => {
    if (e.target.closest('.cmhc-menu-item')) close(m, { focusTrigger: true });
  });
  m.root.addEventListener('focusout', (e) => {
    if (!m.root.contains(e.relatedTarget)) close(m);
  });
}

export function initNavMenus() {
  menus = [...document.querySelectorAll('.cmhc-menu')].map((root) => ({
    root,
    bar: root.closest('.cmhc-menubar'),
    trigger: root.querySelector('.cmhc-menu-trigger'),
    panel: root.querySelector('.cmhc-menu-panel'),
    current: root.querySelector('.cmhc-menu-current'),
  })).filter((m) => m.trigger && m.panel);
  for (const m of menus) wire(m);
  document.addEventListener('pointerdown', (e) => {
    for (const m of menus) if (!m.root.contains(e.target)) close(m);
  });
}

/** Mark the menu holding `tab` as current and show the tab's name on it. */
export function syncNavMenus(tab) {
  for (const m of menus) {
    const item = m.panel.querySelector(`.cmhc-menu-item[data-tab="${tab}"]`);
    m.root.classList.toggle('cmhc-menu-active', Boolean(item));
    if (m.current) m.current.textContent = item ? item.textContent.trim() : '';
  }
}
