/*
 * main.js — app entry. Wires the panels together:
 *   connectPanel  → state.bundle (parsed export)
 *   filtersPanel  → state.filters   (the map's subject/radius patch into it)
 *   resultsTable, mapView ← applyFilters(bundle.listings, filters)
 * Charts (phase 5) hang off the same filtered rows.
 */

import { initConnectPanel, dateLabel } from './connectPanel.js';
import { initFiltersPanel } from './filtersPanel.js';
import { initResultsTable } from './resultsTable.js';
import { initMapView } from './mapView.js';
import { initEvidenceViewer } from './evidence.js';
import { initAnalysis } from './analysis.js';
import { describeFilters } from './lib/exports.js';
import { applyFilters, annotateDistance, subjectOf, defaultFilters } from './lib/filters.js';
import { buildMuniIndex } from './lib/munis.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('en-CA');

const state = {
  bundle: null,     // { manifest, listings, segments } or null
  filters: null,
  filtered: [],
  muniIndex: null,  // lib/munis buildMuniIndex(public/data/muni-index.json)
};

// Regions + adjacency for the municipality picker and the map's selection
// tint — shipped with the site (built from the same CSV the Parcel Search
// uses). Loaded once; the app works without it, just ungrouped.
const muniIndexReady = fetch('data/muni-index.json')
  .then((r) => (r.ok ? r.json() : []))
  .then((raw) => { state.muniIndex = buildMuniIndex(raw); return state.muniIndex; })
  .catch(() => { state.muniIndex = buildMuniIndex([]); return state.muniIndex; });

const $sourcesCard = $('sources-card');
const $sourcesBody = $('sources-table')?.querySelector('tbody');
const $status = $('status-line');

function setStatus(msg) { if ($status) $status.textContent = msg; }

function td(text, cls) {
  const cell = document.createElement('td');
  cell.textContent = text ?? '';
  if (cls) cell.className = cls;
  return cell;
}

function renderSources(bundle) {
  const m = bundle.manifest;
  $sourcesBody.textContent = '';
  for (const s of m.sources || []) {
    const tr = document.createElement('tr');
    tr.append(
      td(s.name), td(fmt(s.listings), 'num'),
      td(s.status || '—', s.status ? `status-${s.status}` : ''),
      td(s.finished_at ? dateLabel(s.finished_at) : '—'),
    );
    $sourcesBody.appendChild(tr);
  }
  $sourcesCard.hidden = false;
}

const policy = () => state.bundle?.manifest?.policy || {};
const asOf = () => { const m = state.bundle?.manifest; return m ? (m.observed?.last || m.generated_at?.slice(0, 10)) : null; };
const evidence = initEvidenceViewer({ setStatus });
const table = initResultsTable({
  getPolicy: policy,
  setStatus,
  onEvidence: (l) => evidence.open(l),
  getContext: () => ({
    filters: state.filters,
    asOf: asOf(),
    published: state.bundle ? dateLabel(state.bundle.manifest.generated_at) : null,
    extraCriteria: viewCriteria(),
  }),
});

/** "Within the map view …" line for exports while the grid follows the map. */
function viewCriteria() {
  const v = state.view;
  if (!v) return [];
  const f = (x) => x.toFixed(4);
  return [`Within the map view at export time: lng ${f(v.w)} to ${f(v.e)}, lat ${f(v.s)} to ${f(v.n)}`];
}
const mapView = initMapView({
  container: 'map',
  getBands: () => policy().bedroom_bands,
  getMuniIndex: () => state.muniIndex,
  onSubjectChange(s) {
    fromMap(() => filters.patch(s
      ? { subjectLat: String(s.lat), subjectLng: String(s.lng), radiusKm: s.radiusKm ? String(s.radiusKm) : '' }
      : { subjectLat: '', subjectLng: '', radiusKm: '' }));
  },
  onMuniToggle: (name) => fromMap(() => filters.toggleMuni(name)),
  onMlsToggle: (name) => fromMap(() => filters.toggleMls(name)),
  onShapesChange: (shapes) => fromMap(() => filters.patch({ shapes })),
});

// Filter changes made ON the map (shape, subject, municipality click) must
// not re-zoom the map; changes from the sidebar do. The flag is set around
// the map-originated patch so the synchronous onChange sees it.
let mapOriginated = false;
function fromMap(fn) { mapOriginated = true; try { fn(); } finally { mapOriginated = false; } }

// ---- workspace tabs -------------------------------------------------------
const TAB_KEY = 'mbre_tab_v1';
const $tabs = document.querySelector('.tabs');
const analysis = initAnalysis({
  getPolicy: policy,
  setStatus,
  getContext: () => ({
    criteria: [...(state.filters ? describeFilters(state.filters, { asOf: asOf(), policy: policy() }) : []), ...viewCriteria()],
    published: state.bundle ? dateLabel(state.bundle.manifest.generated_at) : null,
  }),
});
function setTab(name) {
  for (const b of $tabs.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.tabpanel')) p.hidden = p.id !== `tab-${name}`;
  analysis.setVisible(name === 'analysis');
  if (name === 'listings') setTimeout(() => mapView.resize(), 0);
  try { localStorage.setItem(TAB_KEY, name); } catch { /* ignore */ }
}
$tabs.addEventListener('click', (e) => { const b = e.target.closest('[role="tab"]'); if (b) setTab(b.dataset.tab); });
try { const t = localStorage.getItem(TAB_KEY); if (t === 'analysis') setTab(t); } catch { /* ignore */ }

function recompute({ fit = true } = {}) {
  if (!state.bundle || !state.filters) return;
  const m = state.bundle.manifest;
  const f = state.filters;
  const ctx = { asOf: asOf(), policy: m.policy || {}, muniIndex: state.muniIndex };
  state.filtered = applyFilters(state.bundle.listings, f, ctx);
  const subject = subjectOf(f);
  annotateDistance(state.filtered, subject);
  mapView.setSubject(subject, f.radiusKm);
  mapView.setShapes(f.shapes);
  mapView.setMuniSelection(filters.effectiveMunis(), f.munis);
  mapView.setMlsSelection(f.mls);
  // The map always plots the whole filtered set; the grid and analysis
  // see the viewport subset only while "follows map view" is on.
  mapView.setRows(state.filtered, { fit });
  applyView();
}

/**
 * Viewport narrowing (opt-in). Not part of the filter state — it is a
 * way of looking at the filtered set, so Reset, reload and the URL of the
 * moment do not carry it — but it is written into export criteria.
 */
state.view = null;   // {w,s,e,n} while following, else null
function inView(l) {
  const v = state.view;
  return !v || (l.lat != null && l.lng != null && l.lng >= v.w && l.lng <= v.e && l.lat >= v.s && l.lat <= v.n);
}
function applyView() {
  const rows = state.view ? state.filtered.filter(inView) : state.filtered;
  state.shown = rows;
  table.setRows(rows, { note: state.view ? `map view · ${fmt(state.filtered.length)} in the full selection` : '' });
  analysis.update({ filtered: rows });
}
mapView.onViewChange((bounds) => { state.view = bounds; if (state.bundle) applyView(); });

/** The province-wide reference set: the default view (active, canonical). */
function computeAll() {
  if (!state.bundle) return [];
  return applyFilters(state.bundle.listings, defaultFilters(), { asOf: asOf(), policy: policy(), muniIndex: state.muniIndex });
}

const filters = initFiltersPanel({
  onChange(f) {
    state.filters = f;
    recompute({ fit: !mapOriginated });
  },
});
state.filters = filters.getFilters();
mapView.setSubject(subjectOf(state.filters), state.filters.radiusKm);
// "Reset search" in the workspace is the same reset as the Filters panel's.
$('reset-search')?.addEventListener('click', () => { filters.setFilters(defaultFilters()); setStatus('Search reset — every filter is back to its default.'); });

initConnectPanel({
  setStatus,
  onBundle(bundle) {
    state.bundle = bundle;
    if (!bundle) {
      $sourcesCard.hidden = true;
      table.clear();
      mapView.setRows([]);
      analysis.update({ filtered: [], all: [], listings: [], segments: [] });
      setStatus('Connect the export folder to begin.');
      return;
    }
    renderSources(bundle);
    muniIndexReady.then((index) => {
      filters.setOptions(bundle, index);
      state.filters = filters.getFilters();
      analysis.update({ listings: bundle.listings, segments: bundle.segments, all: computeAll() });
      recompute();
    });
    setStatus(`${fmt(bundle.listings.length)} listings loaded · published ${dateLabel(bundle.manifest.generated_at)}`
      + (bundle.manifest.health === 'degraded' ? ` · coverage degraded: ${(bundle.manifest.degraded_sources || []).join(', ')}` : ''));
  },
});

// Dev-only handle for poking the map from the console (never in production).
if (import.meta.env?.DEV) window.__mbre = { state, mapView, filters, table, analysis, setTab };

const $build = $('about-build');
if ($build) {
  $build.textContent = `Build ${typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev'}`
    + (typeof __APP_BUILD_TIME__ === 'string' ? ` · ${__APP_BUILD_TIME__.slice(0, 10)}` : '');
}
