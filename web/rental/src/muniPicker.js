/*
 * muniPicker.js — the municipality control: a compact <details> that opens
 * a searchable, region-grouped checkbox list (the Parcel Search's Sales
 * Analysis groupings), with Select all / Clear and the "Adjacent regions"
 * pill. Ported from the parcel search's salesDbPanel.renderMuniList.
 *
 * State is three things filtersPanel reads back:
 *   picked    — municipalities the user chose (names)
 *   adjacent  — the pill: include every neighbour of a pick
 *   excluded  — neighbours the user unticked while adjacency was on
 * The derived "effective" set is computed by lib/munis.effectiveMunis so
 * the sidebar, the map tint and the filter can never disagree.
 *
 * Every change dispatches a bubbling `change` event on the root, which is
 * how filtersPanel notices — the same path plain inputs take.
 */

import { effectiveMunis, groupByRegion, neighboursOf } from './lib/munis.js';
import { UNASSIGNED } from './lib/filters.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-CA');

export function initMuniPicker(root, { pill } = {}) {
  const stub = { setOptions() {}, getState: () => ({ munis: [], adjacent: false, muniExcluded: [] }), setState() {}, toggle() {}, effective: () => [] };
  if (!root) return stub;
  const $label = root.querySelector('.multiselect-label');
  const $search = root.querySelector('.multiselect-search');
  const $all = root.querySelector('[data-role="all"]');
  const $clear = root.querySelector('[data-role="clear"]');
  const $groups = root.querySelector('.muni-groups');
  const $count = document.getElementById('f-munis-count');
  const $pill = pill || null;

  let index = null;              // lib/munis buildMuniIndex()
  let tally = [];                // [{value, count}] from the bundle
  let groups = [];               // groupByRegion output
  let available = new Set();     // names the bundle holds
  const picked = new Set();
  const excluded = new Set();
  let adjacent = false;

  const emit = () => root.dispatchEvent(new Event('change', { bubbles: true }));
  const effective = () => effectiveMunis({ munis: [...picked], adjacent, muniExcluded: [...excluded] }, index, available);

  function labelOf(name) {
    if (name === UNASSIGNED) return '(unassigned)';
    return index?.byName.get(name)?.list_name || name;
  }

  function updateLabel() {
    const eff = effective();
    const extra = eff.length - picked.size;
    $label.textContent = picked.size === 0 ? 'Any municipality'
      : picked.size === 1 && extra === 0 ? labelOf([...picked][0])
        : `${picked.size} selected${extra > 0 ? ` + ${extra} adjacent` : ''}`;
    root.classList.toggle('has-selection', picked.size > 0);
    if ($count) {
      const listings = tally.reduce((s, t) => s + (eff.includes(t.value) ? t.count : 0), 0);
      $count.textContent = picked.size ? `${fmt(listings)} listings in the selected municipalities` : '';
    }
    if ($pill) {
      for (const b of $pill.querySelectorAll('[data-mode]')) {
        const on = (b.dataset.mode === 'on') === adjacent;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('active', on);
      }
    }
  }

  function visibleRows() {
    const q = ($search?.value || '').trim().toLowerCase();
    const out = [];
    for (const g of groups) for (const r of g.rows) if (!q || r.label.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) out.push(r);
    return out;
  }

  function renderGroups() {
    $groups.textContent = '';
    const q = ($search?.value || '').trim().toLowerCase();
    const eff = new Set(effective());
    let any = false;
    for (const g of groups) {
      const rows = g.rows.filter((r) => !q || r.label.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
      if (!rows.length) continue;
      any = true;
      const wrap = document.createElement('details');
      wrap.className = 'muni-region';
      wrap.open = Boolean(q) || rows.some((r) => eff.has(r.name));
      const sum = document.createElement('summary');
      const box = document.createElement('input');
      box.type = 'checkbox';
      const n = rows.filter((r) => picked.has(r.name)).length;
      box.checked = n === rows.length;
      box.indeterminate = n > 0 && n < rows.length;
      box.setAttribute('aria-label', `Select every municipality in ${g.region}`);
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', (e) => {
        e.stopPropagation();
        for (const r of rows) {
          if (box.checked) { picked.add(r.name); excluded.delete(r.name); } else picked.delete(r.name);
        }
        renderGroups(); updateLabel(); emit();
      });
      const name = document.createElement('span');
      name.className = 'muni-region-name';
      name.textContent = `${g.region} (${rows.length})`;
      sum.append(box, name);
      wrap.appendChild(sum);
      for (const r of rows) {
        const row = document.createElement('label');
        row.className = 'multiselect-item muni-row';
        const via = !picked.has(r.name) && eff.has(r.name);
        if (via) row.classList.add('is-adjacent');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = r.name;
        cb.checked = eff.has(r.name);
        cb.addEventListener('change', (e) => {
          e.stopPropagation();
          if (cb.checked) { picked.add(r.name); excluded.delete(r.name); }
          else if (via) excluded.add(r.name);
          else picked.delete(r.name);
          renderGroups(); updateLabel(); emit();
        });
        const txt = document.createElement('span');
        txt.textContent = r.label;
        if (via) txt.title = 'Included because it borders a selected municipality';
        const cnt = document.createElement('span');
        cnt.className = 'multiselect-count';
        cnt.textContent = fmt(r.count);
        row.append(cb, txt, cnt);
        wrap.appendChild(row);
      }
      $groups.appendChild(wrap);
    }
    if (!any) {
      const p = document.createElement('p');
      p.className = 'multiselect-empty';
      p.textContent = groups.length ? 'No municipality matches that filter.' : 'No values.';
      $groups.appendChild(p);
    }
  }

  $search?.addEventListener('input', renderGroups);
  $search?.addEventListener('change', (e) => e.stopPropagation());
  $all?.addEventListener('click', () => {
    for (const r of visibleRows()) { picked.add(r.name); excluded.delete(r.name); }
    renderGroups(); updateLabel(); emit();
  });
  $clear?.addEventListener('click', () => {
    picked.clear(); excluded.clear();
    renderGroups(); updateLabel(); emit();
  });
  $pill?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    const next = b.dataset.mode === 'on';
    if (next === adjacent) return;
    adjacent = next;
    if (!adjacent) excluded.clear();   // start from the plain rule next time
    renderGroups(); updateLabel(); emit();
  });
  document.addEventListener('click', (e) => { if (root.open && !root.contains(e.target)) root.open = false; });

  return {
    /** @param {Array<{value,count}>} nextTally  @param {Object} nextIndex lib/munis index */
    setOptions(nextTally, nextIndex) {
      tally = nextTally || [];
      index = nextIndex || index;
      available = new Set(tally.map((t) => t.value));
      groups = groupByRegion(tally, index);
      for (const n of [...picked]) if (!available.has(n)) picked.delete(n);
      renderGroups(); updateLabel();
    },
    getState: () => ({ munis: [...picked], adjacent, muniExcluded: [...excluded] }),
    setState({ munis = [], adjacent: adj = false, muniExcluded = [] } = {}) {
      picked.clear(); for (const n of munis) picked.add(String(n));
      excluded.clear(); for (const n of muniExcluded) excluded.add(String(n));
      adjacent = Boolean(adj);
      renderGroups(); updateLabel();
    },
    /** Flip one municipality (from a map click). Unknown names are ignored. */
    toggle(name) {
      if (!available.has(name)) return false;
      const eff = new Set(effective());
      if (picked.has(name)) picked.delete(name);
      else if (eff.has(name)) excluded.add(name);      // waive off a derived neighbour
      else { picked.add(name); excluded.delete(name); }
      renderGroups(); updateLabel(); emit();
      return true;
    },
    effective,
    neighbours: () => [...neighboursOf([...picked], index, available)],
  };
}
