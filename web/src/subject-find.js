/*
 * "Find the subject" combobox for the framed dashboards' maps (Rental and
 * Commercial): type an address or "lat, lng", pick a suggestion, and the
 * subject point lands there. Extracted from the Commercial dashboard so both
 * maps carry the same control (Jason, 2026-09-30).
 *
 * What resolves a query is the caller's business — Commercial searches the
 * city's civic address points plus its listings, Rental its own listings —
 * via `lookup(query) → Promise<[{ label, lat, lng, source, where }]>`
 * (commercial/src/lib/subjectLookup.js builds both). This is only the box.
 * Styles: lib/subapp-house.css (.subject-find, .subject-suggest).
 */

/**
 * @param {Object} o
 * @param {HTMLInputElement} o.$find
 * @param {HTMLUListElement} o.$suggest
 * @param {(q: string) => Promise<Array>} o.lookup
 * @param {(hit: Object) => void} o.onPick   place the subject at hit.lat / hit.lng
 * @param {string} [o.addressLabel]          how an 'address' hit is labelled
 */
export function initSubjectFind({ $find, $suggest, lookup, onPick, addressLabel = 'Winnipeg address' }) {
  if (!$find || !$suggest) return { clear() {} };
  let hits = [];
  let active = -1;
  let seq = 0;

  function closeSuggest() {
    $suggest.hidden = true;
    $find.setAttribute('aria-expanded', 'false');
    $find.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function paintSuggest(message) {
    $suggest.textContent = '';
    if (!hits.length) {
      if (!message) { closeSuggest(); return; }
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = message;
      $suggest.appendChild(li);
    }
    hits.forEach((h, i) => {
      const li = document.createElement('li');
      li.id = `${$find.id}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      const name = document.createElement('span');
      name.textContent = h.label;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = h.source === 'address' ? addressLabel
        : h.source === 'coordinates' ? 'coordinates' : (h.where || 'listing');
      li.append(name, where);
      // mousedown, not click: a click fires after the input's blur, and the
      // blur would already have closed the list it landed on.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(h); });
      $suggest.appendChild(li);
    });
    $suggest.hidden = false;
    $find.setAttribute('aria-expanded', 'true');
    if (active >= 0) $find.setAttribute('aria-activedescendant', `${$find.id}-opt-${active}`);
    else $find.removeAttribute('aria-activedescendant');
  }

  function pick(h) {
    closeSuggest();
    $find.value = h.label;
    onPick(h);
  }

  async function refresh() {
    const q = $find.value.trim();
    const mine = ++seq;
    if (q.length < 2) { hits = []; closeSuggest(); return; }
    const found = await lookup(q);
    if (mine !== seq) return;          // a later keystroke already answered
    hits = found || [];
    active = hits.length ? 0 : -1;
    paintSuggest(/\d/.test(q) ? 'No address or listing by that number here'
      : 'Start with the civic number, or paste lat, lng');
  }

  let timer = null;
  $find.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });
  $find.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hits.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      paintSuggest();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      if (hits.length) pick(hits[Math.max(0, active)]);
      else refresh();
    } else if (e.key === 'Escape') {
      closeSuggest();
    }
  });
  $find.addEventListener('blur', () => setTimeout(closeSuggest, 0));
  $find.addEventListener('focus', () => { if (hits.length) paintSuggest(); });

  return {
    /** Empty the box (the subject was cleared or placed another way). */
    clear() { $find.value = ''; hits = []; closeSuggest(); },
  };
}
