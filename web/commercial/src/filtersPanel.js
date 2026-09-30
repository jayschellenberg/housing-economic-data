/*
 * filtersPanel.js — turns the sidebar controls into a filter-state
 * object and back. Knows the DOM; knows nothing about how the filters
 * are applied (lib/filters.js) or what they produce (resultsTable.js).
 *
 * Contract: onChange(filters) fires whenever the state changes.
 */

import { DEFAULT_FILTERS, defaultFilters, optionsFor, describeFilters, isDefault } from './lib/filters.js';
import { initMultiSelect, retainSelection } from './lib/multiSelect.js';

const $ = (id) => document.getElementById(id);

// Multi-select id → the record field it draws its options from.
const PICKERS = {
  'f-space': { field: 'space_type', state: 'spaceTypes', placeholder: 'Any type' },
  'f-listing': { field: 'listing_type', state: 'listingTypes', placeholder: 'Sale + lease' },
  'f-status': { field: 'status', state: 'statuses', placeholder: 'Any status' },
  'f-brokerage': { field: 'brokerage', state: 'brokerages', placeholder: 'Any brokerage', searchable: true },
  'f-muni': { field: 'municipality', state: 'municipalities', placeholder: 'Any municipality', searchable: true },
  'f-cluster': { field: 'cluster', state: 'clusters', placeholder: 'Any cluster' },
  'f-nbhd': { field: 'neighbourhood', state: 'neighbourhoods', placeholder: 'Any neighbourhood', searchable: true },
};

// Plain inputs: element id → state key. Text and number fields both
// carry '' for "no bound", which is what DEFAULT_FILTERS uses.
const TEXT_INPUTS = {
  'f-text': 'text', 'f-sf-lo': 'sfLo', 'f-sf-hi': 'sfHi',
  'f-rate-lo': 'rateLo', 'f-rate-hi': 'rateHi',
  'f-price-lo': 'priceLo', 'f-price-hi': 'priceHi',
  'f-from': 'from', 'f-to': 'to',
};

const CHECKBOXES = {
  'f-flyer': 'hasFlyer', 'f-mapped': 'mappedOnly',
  'f-plausible': 'plausibleOnly', 'f-collapse': 'collapseDuplicates',
  'f-brokerage-only': 'brokerageSourcesOnly',
};

export function initFiltersPanel({ onChange } = {}) {
  const root = $('filters');
  if (!root) return { setRecords() {}, get: defaultFilters, set() {}, renderChips() {} };

  let state = defaultFilters();
  let records = [];
  const pickers = {};

  for (const [id, spec] of Object.entries(PICKERS)) {
    pickers[id] = initMultiSelect($(id), {
      placeholder: spec.placeholder,
      noun: 'selected',
      searchable: Boolean(spec.searchable),
    });
  }

  const emit = () => { renderChips(); onChange?.({ ...state }); };

  function readControls() {
    for (const [id, key] of Object.entries(TEXT_INPUTS)) {
      const el = $(id);
      if (el) state[key] = el.value;
    }
    for (const [id, key] of Object.entries(CHECKBOXES)) {
      const el = $(id);
      if (el) state[key] = Boolean(el.checked);
    }
    const market = root.querySelector('input[name="f-market"]:checked');
    if (market) state.market = market.value;
    const scope = root.querySelector('input[name="f-text-scope"]:checked');
    if (scope) state.textScope = scope.value;
    for (const [id, spec] of Object.entries(PICKERS)) {
      state[spec.state] = pickers[id].getSelected();
    }
  }

  function writeControls() {
    for (const [id, key] of Object.entries(TEXT_INPUTS)) {
      const el = $(id);
      if (el) el.value = state[key] ?? '';
    }
    for (const [id, key] of Object.entries(CHECKBOXES)) {
      const el = $(id);
      if (el) el.checked = Boolean(state[key]);
    }
    const market = root.querySelector(`input[name="f-market"][value="${state.market}"]`);
    if (market) market.checked = true;
    const scope = root.querySelector(`input[name="f-text-scope"][value="${state.textScope}"]`);
    if (scope) scope.checked = true;
    syncSearchPlaceholder();
    for (const [id, spec] of Object.entries(PICKERS)) {
      pickers[id].setSelected(state[spec.state] || []);
    }
  }

  // The placeholder names the fields the chosen scope actually reads, so
  // "why didn't my zoning code match" is answerable without the source.
  const SCOPE_PLACEHOLDER = {
    address: 'address, name, unit, roll',
    notes: 'anything in the comments',
    all: 'address, name, zoning, roll, comments',
  };
  function syncSearchPlaceholder() {
    const el = $('f-text');
    if (el) el.placeholder = SCOPE_PLACEHOLDER[state.textScope] || SCOPE_PLACEHOLDER.address;
  }

  // Re-render only when the filters actually changed. Leaving the search
  // box fires `change` on blur for text the `input` handler has ALREADY
  // applied, and re-rendering then rebuilt the grid under the pointer: a
  // click on a row's Flyer or Snapshot link straight after typing landed
  // on a button that no longer existed by mouseup, and did nothing.
  let applied = JSON.stringify(state);
  function applyControls() {
    readControls();
    syncSearchPlaceholder();
    const now = JSON.stringify(state);
    if (now === applied) return;
    applied = now;
    emit();
  }
  root.addEventListener('change', applyControls);
  // Typing in the search box should not wait for a blur.
  $('f-text')?.addEventListener('input', debounce(applyControls, 200));

  $('f-clear')?.addEventListener('click', () => {
    state = defaultFilters();
    writeControls();
    applied = JSON.stringify(state);
    emit();
  });

  /**
   * Refresh the pickers' options from the connected bundle. Options are
   * drawn from ALL records, not the filtered set, so choosing "Retail"
   * does not make every other type vanish from its own menu.
   */
  function setRecords(next, manifest) {
    records = next || [];
    for (const [id, spec] of Object.entries(PICKERS)) {
      const opts = optionsFor(records, spec.field);
      pickers[id].setOptions(opts);
      // A reconnect to a different bundle can retire a value that was
      // selected; keep what still exists rather than filtering to nothing.
      state[spec.state] = retainSelection(state[spec.state], opts.map((o) => o.value));
      pickers[id].setSelected(state[spec.state]);
    }
    // Offered only when the folder says which rows Moody's added — a
    // folder published before record_source existed has none to leave out.
    const wrap = $('f-brokerage-only-wrap');
    if (wrap) wrap.hidden = !records.some((r) => r.record_source);
    const cycle = manifest?.cycles;
    if (cycle) {
      for (const id of ['f-from', 'f-to']) {
        const el = $(id);
        if (el) {
          el.min = cycle.first || '';
          el.max = cycle.last || '';
          el.placeholder = id === 'f-from' ? (cycle.first || '') : (cycle.last || '');
        }
      }
    }
    // retainSelection may have dropped a value this bundle no longer has.
    applied = JSON.stringify(state);
    renderChips(manifest);
  }

  let lastManifest = null;
  function renderChips(manifest) {
    if (manifest) lastManifest = manifest;
    const host = $('filter-chips');
    if (!host) return;
    host.textContent = '';
    for (const chip of describeFilters(state, lastManifest)) {
      const el = document.createElement('span');
      el.className = chip.sticky ? 'chip chip-sticky' : 'chip';
      el.textContent = chip.label;
      host.appendChild(el);
    }
    const clear = $('f-clear');
    if (clear) clear.disabled = isDefault(state);
  }

  writeControls();

  return {
    setRecords,
    get: () => ({ ...state }),
    set(next) {
      state = { ...DEFAULT_FILTERS, ...next };
      writeControls();
      applied = JSON.stringify(state);
      emit();
    },
    renderChips,
  };
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
