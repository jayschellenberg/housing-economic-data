/*
 * Compact multi-select: a one-line <details> that opens a searchable
 * checkbox list with counts. Adapted from the parcel search's control.
 * Closed, it reads the current state ("Any municipality" / "CITY OF
 * BRANDON" / "3 selected"); open, it overlays the rows below rather
 * than pushing them down the sidebar.
 *
 * Dispatches a bubbling `change` event on the root whenever the
 * selection changes, so it wires up alongside plain inputs.
 *
 * Markup the module fills in:
 *   <details class="multiselect" id="…">
 *     <summary><span class="multiselect-label"></span></summary>
 *     <div class="multiselect-menu"></div>
 *   </details>
 */

const fmtCount = (n) => Number(n || 0).toLocaleString('en-CA');

export function summarizeSelection(selected, { placeholder = 'Any', noun = 'selected', labelOf } = {}) {
  const list = (selected || []).filter((v) => v !== '' && v != null);
  if (list.length === 0) return placeholder;
  if (list.length === 1) return String((labelOf ? labelOf(list[0]) : list[0]) ?? list[0]);
  return `${list.length} ${noun}`;
}

export function retainSelection(previousSelected, nextValues) {
  const available = new Set(nextValues || []);
  return (previousSelected || []).filter((v) => available.has(v));
}

/**
 * @param {HTMLElement} root
 * @param {{placeholder?:string, noun?:string, searchable?:boolean}} opts
 */
export function initMultiSelect(root, { placeholder = 'Any', noun = 'selected', searchable = false } = {}) {
  const stub = { setOptions() {}, getSelected: () => [], setSelected() {}, clear() {}, isEmpty: () => true };
  if (!root) return stub;
  const $label = root.querySelector('.multiselect-label');
  const $menu = root.querySelector('.multiselect-menu');
  if (!$label || !$menu) return stub;

  let options = [];                 // [{value, label, count}]
  const selected = new Set();
  let $search = null;

  const labelOf = (v) => options.find((o) => o.value === v)?.label ?? v;

  function updateLabel() {
    $label.textContent = summarizeSelection([...selected], { placeholder, noun, labelOf });
    root.classList.toggle('has-selection', selected.size > 0);
  }

  function renderList() {
    const q = ($search?.value || '').trim().toLowerCase();
    let $list = $menu.querySelector('.multiselect-list');
    if (!$list) { $list = document.createElement('div'); $list.className = 'multiselect-list'; $menu.appendChild($list); }
    $list.textContent = '';
    if (!options.length) {
      const p = document.createElement('p'); p.className = 'multiselect-empty'; p.textContent = 'No values.';
      $list.appendChild(p);
      return;
    }
    for (const o of options) {
      if (q && !o.label.toLowerCase().includes(q)) continue;
      const lab = document.createElement('label');
      lab.className = 'multiselect-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = o.value;
      cb.checked = selected.has(o.value);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(o.value); else selected.delete(o.value);
        updateLabel();
        root.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const text = document.createElement('span');
      text.textContent = o.label;
      const count = document.createElement('span');
      count.className = 'multiselect-count';
      count.textContent = o.count != null ? fmtCount(o.count) : '';
      lab.append(cb, text, count);
      $list.appendChild(lab);
    }
  }

  function renderMenu() {
    $menu.textContent = '';
    if (searchable) {
      $search = document.createElement('input');
      $search.type = 'search';
      $search.className = 'multiselect-search';
      $search.placeholder = 'Filter…';
      $search.setAttribute('aria-label', 'Filter options');
      $search.addEventListener('input', renderList);
      $menu.appendChild($search);
    }
    const tools = document.createElement('div');
    tools.className = 'multiselect-tools';
    // "All" ticks every option the search currently shows — so typing "1"
    // then All selects the MLS areas starting with 1, not the whole list.
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.textContent = 'Select all';
    allBtn.title = 'Select every option currently listed';
    allBtn.addEventListener('click', () => {
      const q = ($search?.value || '').trim().toLowerCase();
      for (const o of options) if (!q || o.label.toLowerCase().includes(q)) selected.add(o.value);
      renderList(); updateLabel();
      root.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => { api.clear(); root.dispatchEvent(new Event('change', { bubbles: true })); });
    tools.append(allBtn, clearBtn);
    $menu.appendChild(tools);
    renderList();
  }

  // Close when clicking outside, so an open menu never lingers over the
  // controls below it.
  document.addEventListener('click', (e) => {
    if (root.open && !root.contains(e.target)) root.open = false;
  });

  const api = {
    /** @param {Array<{value:string,label?:string,count?:number}>} opts */
    setOptions(opts) {
      options = (opts || []).map((o) => ({ value: String(o.value), label: o.label ?? String(o.value), count: o.count }));
      const keep = retainSelection([...selected], options.map((o) => o.value));
      selected.clear();
      for (const v of keep) selected.add(v);
      renderMenu();
      updateLabel();
    },
    getSelected: () => [...selected],
    setSelected(values) {
      selected.clear();
      const known = new Set(options.map((o) => o.value));
      for (const v of values || []) if (known.has(String(v))) selected.add(String(v));
      renderList();
      updateLabel();
    },
    clear() { selected.clear(); renderList(); updateLabel(); },
    isEmpty: () => selected.size === 0,
    /** Flip one value (e.g. from a map click) and announce the change. */
    toggle(value) {
      const v = String(value);
      if (!options.some((o) => o.value === v)) return false;
      if (selected.has(v)) selected.delete(v); else selected.add(v);
      renderList(); updateLabel();
      root.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
  };
  renderMenu();
  updateLabel();
  return api;
}
