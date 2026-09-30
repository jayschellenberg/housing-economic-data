/**
 * A sticky row of chips at the top of the chart grid, one per section, so
 * a reader can jump straight to industrial, retail or office without
 * scrolling the sidebar. `sections` is [{ id, label }] of the sections
 * actually drawn.
 */
export function buildJumpBar(sections) {
  const nav = document.createElement('nav');
  nav.className = 'cmhc-jump-bar';
  nav.setAttribute('aria-label', 'Jump to section');
  for (const { id, label } of sections) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cmhc-jump-chip';
    b.textContent = label;
    b.addEventListener('click', () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    nav.appendChild(b);
  }
  return nav;
}
