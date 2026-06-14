/*
 * Filter UI controller. Reads + writes the global state object, populates
 * the geography-level + geography-name dropdowns from geographies.json,
 * and disables breakdown radios that the active series doesn't support.
 */

const LEVEL_LABEL = {
  province:      'Province',
  cma:           'CMA / CA',
  csd:           'Census Subdivision',
  zone:          'Survey Zone',
  neighbourhood: 'Neighbourhood',
};

export function initFilters({ geographies, capabilities, categoryOrder = {}, initialState, onChange }) {
  const $level     = document.getElementById('geo-level');
  const $name      = document.getElementById('geo-name');
  const $dwelling  = document.querySelectorAll('input[name="dwellingType"]');
  const $yearFrom  = document.getElementById('year-from');
  const $yearTo    = document.getElementById('year-to');
  const $breakdown = document.querySelectorAll('input[name="breakdown"]');
  const $banner    = document.getElementById('zone-banner');
  const $catToggles = document.getElementById('category-toggles');

  // Populate level dropdown — only levels that actually have items.
  const levels = geographies.levels || {};
  const levelOrder = ['province', 'cma', 'csd', 'zone', 'neighbourhood'];
  const availableLevels = levelOrder.filter(l => Array.isArray(levels[l]) && levels[l].length > 0);
  $level.innerHTML = availableLevels
    .map(l => `<option value="${l}">${LEVEL_LABEL[l] ?? l}</option>`)
    .join('');

  // Apply initial state, defaulting to province / Manitoba.
  const state = {
    geoLevel:     initialState.geoLevel     && availableLevels.includes(initialState.geoLevel) ? initialState.geoLevel : (availableLevels[0] || 'province'),
    geoUid:       initialState.geoUid       || '',
    dwellingType: initialState.dwellingType || 'All',
    yearFrom:     initialState.yearFrom     || null,
    yearTo:       initialState.yearTo       || null,
    breakdown:    initialState.breakdown    || 'Bedroom Type',
    // Per-breakdown hidden category sets. Default: nothing hidden.
    hiddenCategories: initialState.hiddenCategories || {},
  };
  // Ensure every known breakdown has a Set in hiddenCategories so we can
  // mutate without worrying about undefined.
  Object.keys(categoryOrder).forEach(bd => {
    if (!Array.isArray(state.hiddenCategories[bd])) state.hiddenCategories[bd] = [];
  });

  function applyToInputs() {
    $level.value = state.geoLevel;
    populateNames();
    if (state.geoUid && [...$name.options].some(o => o.value === state.geoUid)) {
      $name.value = state.geoUid;
    } else if ($name.options.length > 0) {
      state.geoUid = $name.options[0].value;
      $name.value = state.geoUid;
    }
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

  function populateNames() {
    const items = levels[state.geoLevel] || [];
    $name.disabled = items.length === 0;
    $name.innerHTML = items
      .map(it => `<option value="${it.uid}">${escapeHtml(formatNameOption(it))}</option>`)
      .join('') || '<option>&nbsp;</option>';
  }

  function formatNameOption(it) {
    if (it.parentName && state.geoLevel !== 'cma' && state.geoLevel !== 'province' && state.geoLevel !== 'csd') {
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
  $level.addEventListener('change', () => {
    state.geoLevel = $level.value;
    populateNames();
    if ($name.options.length > 0) {
      state.geoUid = $name.options[0].value;
      $name.value = state.geoUid;
    } else {
      state.geoUid = '';
    }
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
