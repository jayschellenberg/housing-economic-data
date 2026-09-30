/*
 * filtersPanel.js — the sidebar's filter controls ⇄ a filters.js state
 * object. Persists the state to localStorage so a refresh keeps the
 * user in place; Clear resets to defaults.
 *
 * Only contract with the rest of the app: onChange(filters) whenever a
 * control moves, and setOptions(bundle) to (re)populate the pickers with
 * the values the connected data actually contains.
 */

import {
  DEFAULT_FILTERS, TYPES, TYPE_LABELS, BEDROOM_BANDS, WINDOWS,
  defaultFilters, normalizeFilters, additionalChips, muniKey,
} from './lib/filters.js';
import { initMultiSelect } from './lib/multiSelect.js';
import { initMuniPicker } from './muniPicker.js';

const STORAGE_KEY = 'mbre_filters_v1';

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeFilters(JSON.parse(raw)) : null;
  } catch { return null; }
}
function writeStored(f) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(f)); } catch { /* private mode etc. */ }
}

/** Count distinct values of `key` (via `get`) over listings, sorted by count desc. */
function tally(listings, get) {
  const m = new Map();
  for (const l of listings) {
    const v = get(l);
    if (v == null || v === '') continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, count]) => ({ value, label: value, count }));
}

export function initFiltersPanel({ onChange } = {}) {
  const $root = document.getElementById('filters-panel');
  if (!$root) return { setOptions() {}, getFilters: defaultFilters, setFilters() {} };
  const $ = (id) => document.getElementById(id);

  // ---- build the checkbox rows from the constants ------------------------
  const $windows = $('f-window');
  for (const w of WINDOWS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'seg-btn'; b.dataset.window = w.key; b.textContent = w.label;
    b.setAttribute('role', 'radio');
    $windows.appendChild(b);
  }
  const $types = $('f-types');
  for (const t of TYPES) {
    const lab = document.createElement('label'); lab.className = 'check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = t; cb.dataset.group = 'types';
    lab.append(cb, document.createTextNode(' ' + TYPE_LABELS[t]));
    $types.appendChild(lab);
  }
  const $beds = $('f-beds');
  for (const b of BEDROOM_BANDS) {
    const lab = document.createElement('label'); lab.className = 'check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = b.key; cb.dataset.group = 'beds';
    lab.append(cb, document.createTextNode(' ' + b.label));
    $beds.appendChild(lab);
  }

  const munis = initMuniPicker($('f-munis'), { pill: $('f-munis-adjacent') });
  const nbhds = initMultiSelect($('f-nbhds'), { placeholder: 'Any neighbourhood', noun: 'neighbourhoods', searchable: true });
  const mls = initMultiSelect($('f-mls'), { placeholder: 'Any MLS area', noun: 'MLS areas', searchable: true });
  const sources = initMultiSelect($('f-sources'), { placeholder: 'Any source', noun: 'sources', searchable: true });

  const ids = {
    from: 'f-from', to: 'f-to', rentLo: 'f-rent-lo', rentHi: 'f-rent-hi', canonicalOnly: 'f-canonical',
    bathsMin: 'f-baths', sqftLo: 'f-sqft-lo', sqftHi: 'f-sqft-hi', psfLo: 'f-psf-lo', psfHi: 'f-psf-hi',
    parking: 'f-parking', elevator: 'f-elevator', furnished: 'f-furnished', pets: 'f-pets', laundry: 'f-laundry',
    heat: 'f-heat', water: 'f-water', electricity: 'f-electricity', address: 'f-address', title: 'f-title',
    coordsOnly: 'f-coords',
  };
  const el = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, $(id)]));
  const $badge = $('filters-badge');
  const $clear = $('filters-clear');
  const $customRow = $('f-custom-row');

  let current = readStored() || defaultFilters();
  let suppress = false;   // while setFilters() writes the controls

  // ---- state → controls ------------------------------------------------
  function write(f) {
    suppress = true;
    for (const b of $windows.querySelectorAll('.seg-btn')) {
      b.setAttribute('aria-checked', String(b.dataset.window === f.window));
    }
    $customRow.hidden = f.window !== 'custom';
    for (const cb of $types.querySelectorAll('input')) cb.checked = f.types.includes(cb.value);
    for (const cb of $beds.querySelectorAll('input')) cb.checked = f.beds.includes(cb.value);
    munis.setState({ munis: f.munis, adjacent: f.adjacent, muniExcluded: f.muniExcluded });
    nbhds.setSelected(f.nbhds); mls.setSelected(f.mls); sources.setSelected(f.sources);
    for (const [k, node] of Object.entries(el)) {
      if (!node) continue;
      if (node.type === 'checkbox') node.checked = Boolean(f[k]);
      else node.value = f[k] ?? '';
    }
    suppress = false;
    renderBadge(f);
  }

  // ---- controls → state ------------------------------------------------
  // Fields with no sidebar control (the map's subject + radius, drawn
  // shapes) ride along from the current state so a checkbox change never
  // wipes them.
  const NON_CONTROL = ['subjectLat', 'subjectLng', 'radiusKm', 'shapes'];
  function read() {
    const f = defaultFilters();
    for (const k of NON_CONTROL) f[k] = current[k];
    f.window = $windows.querySelector('.seg-btn[aria-checked="true"]')?.dataset.window || DEFAULT_FILTERS.window;
    f.types = [...$types.querySelectorAll('input:checked')].map((c) => c.value);
    f.beds = [...$beds.querySelectorAll('input:checked')].map((c) => c.value);
    Object.assign(f, munis.getState());
    f.nbhds = nbhds.getSelected(); f.mls = mls.getSelected(); f.sources = sources.getSelected();
    for (const [k, node] of Object.entries(el)) {
      if (!node) continue;
      f[k] = node.type === 'checkbox' ? node.checked : node.value;
    }
    return normalizeFilters(f);
  }

  function renderBadge(f) {
    const chips = additionalChips(f);
    $badge.hidden = chips.length === 0;
    $badge.textContent = chips.length ? `${chips.length} set` : '';
    $badge.title = chips.map((c) => c.label).join(' · ');
    $clear.disabled = JSON.stringify(f) === JSON.stringify(defaultFilters());
  }

  function emit() {
    if (suppress) return;
    current = read();
    $customRow.hidden = current.window !== 'custom';
    writeStored(current);
    renderBadge(current);
    onChange?.(current);
  }

  // ---- wiring -----------------------------------------------------------
  $windows.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    for (const x of $windows.querySelectorAll('.seg-btn')) x.setAttribute('aria-checked', String(x === b));
    emit();
  });
  $('f-custom-btn')?.addEventListener('click', () => {
    for (const x of $windows.querySelectorAll('.seg-btn')) x.setAttribute('aria-checked', 'false');
    $customRow.hidden = false;
    // A custom window with no dates is "all"; the state says custom so the
    // date inputs stay visible.
    current = { ...read(), window: 'custom' };
    writeStored(current); renderBadge(current); onChange?.(current);
  });
  // Text inputs debounce; everything else fires immediately.
  let timer = null;
  $root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('input[type="text"], input[type="search"]') && !t.classList.contains('multiselect-search')) {
      clearTimeout(timer); timer = setTimeout(emit, 250);
    }
  });
  $root.addEventListener('change', (e) => {
    if (e.target.classList?.contains('multiselect-search')) return;
    emit();
  });
  $clear.addEventListener('click', () => {
    current = defaultFilters();
    write(current);
    writeStored(current);
    onChange?.(current);
  });

  write(current);

  return {
    /** Populate the pickers from the connected bundle's listings. */
    setOptions(bundle, muniIndex = null) {
      const L = bundle?.listings || [];
      munis.setOptions(tally(L, muniKey), muniIndex);
      nbhds.setOptions(tally(L, (l) => l.geo_neighborhood).sort((a, b) => a.label.localeCompare(b.label)));
      mls.setOptions(tally(L, (l) => l.geo_mls_area).sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })));
      sources.setOptions(tally(L, (l) => l.source));
      // A stored selection that the new bundle no longer offers has been
      // dropped by setOptions; re-read so state and controls agree.
      current = read();
      renderBadge(current);
      writeStored(current);
    },
    getFilters: () => current,
    setFilters(f) { current = normalizeFilters(f); write(current); writeStored(current); onChange?.(current); },
    /** Merge a partial state (used by the map for subject + radius + shapes). */
    patch(partial) {
      current = normalizeFilters({ ...current, ...partial });
      writeStored(current);
      renderBadge(current);
      onChange?.(current);
    },
    /** Flip one municipality / MLS area from a map click; the picker emits the change. */
    toggleMuni: (name) => munis.toggle(name),
    toggleMls: (name) => mls.toggle(name),
    /** The municipalities the current state actually covers (picks + adjacency). */
    effectiveMunis: () => munis.effective(),
  };
}
