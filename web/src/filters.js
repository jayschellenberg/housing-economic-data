/*
 * Filter UI controller. Province-first geography cascade: pick a Province, then
 * a Level within it (Entire province / CMA-CA / CSD / Survey Zone / Neighbour-
 * hood — only the levels that province actually has), then the Area at that
 * level. The underlying selection is still (geoLevel, geoUid); province is a UI
 * scoping layer derived from each geography's `prov` field. Also disables
 * breakdown radios the active series doesn't support.
 */

import { escapeHtml } from './escape.js';
import { resolveProvince, rememberProvince } from './prefs.js';

const LEVEL_LABEL = {
  province:      'Entire province',
  cma:           'CMA / CA',
  csd:           'Census Subdivision',
  zone:          'Survey Zone',
  neighbourhood: 'Neighbourhood',
};
const LEVEL_ORDER = ['province', 'cma', 'csd', 'zone', 'neighbourhood'];
const DEFAULT_PROV = '46';  // Manitoba

export function initFilters({ geographies, capabilities, categoryOrder = {}, initialState, onChange }) {
  const $province  = document.getElementById('geo-province');
  const $level     = document.getElementById('geo-level');
  const $name      = document.getElementById('geo-name');
  const $nameWrap  = document.getElementById('geo-name-wrap');
  const $dwelling  = document.querySelectorAll('input[name="dwellingType"]');
  const $yearFrom  = document.getElementById('year-from');
  const $yearTo    = document.getElementById('year-to');
  const $breakdown = document.querySelectorAll('input[name="breakdown"]');
  const $banner    = document.getElementById('zone-banner');
  const $catToggles = document.getElementById('category-toggles');

  const levels = geographies.levels || {};
  const allItems  = LEVEL_ORDER.flatMap(l => levels[l] || []);
  const provOf    = (uid) => allItems.find(it => it.uid === uid)?.prov;
  const itemsFor  = (level, prov) => (levels[level] || []).filter(it => it.prov === prov);
  const levelsFor = (prov) => LEVEL_ORDER.filter(l => itemsFor(l, prov).length > 0);

  // Province dropdown options (from the province level), sorted by name.
  const provinceItems = (levels.province || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const provExists = (p) => provinceItems.some(it => it.prov === p);
  const fallbackProv = () => provExists(DEFAULT_PROV) ? DEFAULT_PROV : provinceItems[0]?.prov;
  // A shared link's geoUid always wins; absent that, open on the visitor's saved
  // "home" province (shared across tabs), else Manitoba.
  const homeProv = resolveProvince(provinceItems.map(it => it.prov), fallbackProv());

  // Initial state. The persisted selection is still (geoLevel, geoUid); province
  // is derived from the saved geoUid.
  const savedProv = initialState.geoUid ? provOf(initialState.geoUid) : null;
  const state = {
    province:     (savedProv && provExists(savedProv)) ? savedProv : homeProv,
    geoLevel:     initialState.geoLevel || 'province',
    geoUid:       initialState.geoUid   || homeProv,
    dwellingType: initialState.dwellingType || 'All',
    yearFrom:     initialState.yearFrom     || null,
    yearTo:       initialState.yearTo       || null,
    breakdown:    initialState.breakdown    || 'Bedroom Type',
    // Per-breakdown hidden category sets. Default: nothing hidden.
    hiddenCategories: initialState.hiddenCategories || {},
  };
  // Ensure every known breakdown has a Set in hiddenCategories so we can mutate
  // without worrying about undefined.
  Object.keys(categoryOrder).forEach(bd => {
    if (!Array.isArray(state.hiddenCategories[bd])) state.hiddenCategories[bd] = [];
  });

  $province.innerHTML = provinceItems
    .map(it => `<option value="${escapeHtml(it.prov)}">${escapeHtml(it.name)}</option>`)
    .join('');

  // Keep province / geoLevel / geoUid mutually consistent before rendering.
  function normalize() {
    if (!provExists(state.province)) state.province = fallbackProv();
    const avail = levelsFor(state.province);
    if (!avail.includes(state.geoLevel)) state.geoLevel = avail.includes('province') ? 'province' : avail[0];
    if (state.geoLevel === 'province') {
      state.geoUid = state.province;                 // "Entire province" = the province uid
    } else {
      const items = itemsFor(state.geoLevel, state.province);
      if (!items.some(it => it.uid === state.geoUid)) state.geoUid = items[0]?.uid || '';
    }
  }

  function populateLevels() {
    const avail = levelsFor(state.province);
    $level.innerHTML = avail.map(l => `<option value="${l}">${LEVEL_LABEL[l] ?? l}</option>`).join('');
    $level.value = state.geoLevel;
  }

  function populateNames() {
    const isProvince = state.geoLevel === 'province';
    if ($nameWrap) $nameWrap.hidden = isProvince;           // Area is implicit for a whole province
    if (isProvince) { $name.innerHTML = ''; $name.disabled = true; return; }
    const items = itemsFor(state.geoLevel, state.province);
    $name.disabled = items.length === 0;
    $name.innerHTML = items
      .map(it => `<option value="${it.uid}">${escapeHtml(formatNameOption(it))}</option>`)
      .join('') || '<option>&nbsp;</option>';
    if (state.geoUid) $name.value = state.geoUid;
  }

  function applyToInputs() {
    normalize();
    $province.value = state.province;
    populateLevels();
    populateNames();
    setRadio($dwelling, state.dwellingType);
    setRadio($breakdown, state.breakdown);
    if (state.yearFrom) $yearFrom.value = state.yearFrom;
    if (state.yearTo)   $yearTo.value   = state.yearTo;
    updateZoneBanner();
    updateBreakdownAvailability();
    renderCategoryToggles();
  }

  // Render show/hide checkboxes for the currently selected breakdown.
  // One checkbox per canonical category in CATEGORY_ORDER[breakdown].
  function renderCategoryToggles() {
    if (!$catToggles) return;
    const cats = categoryOrder[state.breakdown] || [];
    if (cats.length === 0) { $catToggles.innerHTML = ''; return; }
    const hidden = new Set(state.hiddenCategories[state.breakdown] || []);
    $catToggles.innerHTML =
      `<div class="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Show categories</div>` +
      cats.map(cat => `
        <label class="flex items-center gap-1">
          <input type="checkbox" data-cat="${escapeHtml(cat)}" ${hidden.has(cat) ? '' : 'checked'} />
          <span>${escapeHtml(cat)}</span>
        </label>
      `).join('');
    $catToggles.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const cat = cb.dataset.cat;
        const list = new Set(state.hiddenCategories[state.breakdown] || []);
        if (cb.checked) list.delete(cat); else list.add(cat);
        state.hiddenCategories[state.breakdown] = [...list];
        commit();
      });
    });
  }

  function formatNameOption(it) {
    // Within a single province, show the parent CMA for zones/neighbourhoods.
    if (it.parentName && (state.geoLevel === 'zone' || state.geoLevel === 'neighbourhood')) {
      return `${it.name} — ${it.parentName}`;
    }
    return it.name;
  }

  function setRadio(nodes, value) {
    nodes.forEach(n => { n.checked = (n.value === value); });
  }

  function updateZoneBanner() {
    if (!$banner) return;
    $banner.hidden = !(state.geoLevel === 'zone' || state.geoLevel === 'neighbourhood');
    $banner.classList.toggle('hidden', $banner.hidden);
  }

  // Which series limits the breakdown choices the user can pick? The 4 chart
  // panels share one breakdown; the most-restrictive series (Average Rent
  // Change) determines what's enabled. But we don't want to lock the user
  // out of useful dimensions when they don't care about that panel — so we
  // enable a breakdown if ANY of the four panels' series supports it, and
  // mark the others "no data" rather than blocking the radio.
  function updateBreakdownAvailability() {
    const seriesList = ['Median Rent', 'Average Rent', 'Vacancy Rate', 'Average Rent Change'];
    const supportedUnion = new Set();
    seriesList.forEach(s => {
      const dims = capabilities?.series?.[s]?.dimensions || [];
      dims.forEach(d => supportedUnion.add(d));
    });
    $breakdown.forEach(n => {
      n.disabled = !supportedUnion.has(n.value);
      const lbl = n.closest('label');
      if (lbl) lbl.style.opacity = n.disabled ? 0.4 : 1;
    });
    // If current selection is disabled, fall back to the first enabled.
    const current = [...$breakdown].find(n => n.value === state.breakdown);
    if (current?.disabled) {
      const fallback = [...$breakdown].find(n => !n.disabled);
      if (fallback) {
        state.breakdown = fallback.value;
        fallback.checked = true;
      }
    }
  }

  function commit() {
    onChange({ ...state });
  }

  // --- Event wiring --------------------------------------------------------
  $province.addEventListener('change', () => {
    state.province = $province.value;
    rememberProvince(state.province);   // shared home province across tabs
    normalize();          // keep the level if the new province has it, else fall back
    populateLevels();
    populateNames();
    updateZoneBanner();
    commit();
  });

  $level.addEventListener('change', () => {
    state.geoLevel = $level.value;
    normalize();          // sets geoUid (province uid for "Entire province", else first item)
    populateNames();
    updateZoneBanner();
    commit();
  });

  $name.addEventListener('change', () => {
    state.geoUid = $name.value;
    commit();
  });

  $dwelling.forEach(n => n.addEventListener('change', () => {
    if (n.checked) { state.dwellingType = n.value; commit(); }
  }));

  $yearFrom.addEventListener('change', () => {
    const v = parseInt($yearFrom.value, 10);
    state.yearFrom = Number.isFinite(v) ? v : null;
    commit();
  });
  $yearTo.addEventListener('change', () => {
    const v = parseInt($yearTo.value, 10);
    state.yearTo = Number.isFinite(v) ? v : null;
    commit();
  });

  $breakdown.forEach(n => n.addEventListener('change', () => {
    if (n.checked && !n.disabled) {
      state.breakdown = n.value;
      renderCategoryToggles();
      commit();
    }
  }));

  applyToInputs();
  return { getState: () => ({ ...state }), refresh: applyToInputs };
}
