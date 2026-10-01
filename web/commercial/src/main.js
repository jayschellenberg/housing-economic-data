/*
 * main.js — app entry. Wires the panels together:
 *   connectPanel  → state.bundle (the parsed export)
 *   summaryView   ← that bundle
 *   filtersPanel  → state.filters
 *   resultsTable  ← applyFilters(bundle.records, filters, manifest)
 * Map, analysis and the richer exports (phases 4-6) hang off the same
 * state.filtered.
 */

import { initConnectPanel, dateLabel } from './connectPanel.js';
import { renderSummary } from './summaryView.js';
import { initFiltersPanel } from './filtersPanel.js';
import { initResultsTable } from './resultsTable.js';
import { initMapView } from './mapView.js';
import { initAnalysis } from './analysis.js';
import { initFlyerViewer } from './flyerViewer.js';
import { initTabs } from './tabs.js';
import { buildSubjectIndex, lookupSubject } from './lib/subjectLookup.js';
import { FILES } from './lib/bundle.js';
import { getFile } from './lib/store.js';
import { applyFilters, defaultFilters, describeFilters, annotateDistance } from './lib/filters.js';
import { normalizeShapes, passesShapeFilter } from './lib/shapeFilter.js';

const $ = (id) => document.getElementById(id);

// A map overlay's key -> the filter it selects into. Both directions read
// this: a click on the map toggles the picker, and a change in the picker
// re-tints the map, so the two can never fall out of step.
const AREA_FILTER = Object.freeze({
  munis: 'municipalities',
  clusters: 'clusters',
  nbhds: 'neighbourhoods',
});

const state = {
  bundle: null,          // { manifest, records, runs } or null
  filters: defaultFilters(),
  filtered: [],
  // Set on the map, not in the sidebar: drawn include/exclude areas and a
  // subject point with a radius. They filter the same rows, but a change
  // to them must never refit the map — that would yank the view out from
  // under the hand that made it.
  shapes: [],
  subject: null,
  // The map's viewport while "Table follows map view" is on ({w,s,e,n}),
  // else null. Not a filter: the map keeps plotting all of state.filtered;
  // the table, count line and Analysis read state.shown.
  view: null,
  shown: [],
};

function setStatus(msg) {
  const el = $('status-line');
  if (el) el.textContent = msg;
}

const flyers = initFlyerViewer({ setStatus });

const results = initResultsTable({
  setStatus,
  getContext: () => ({
    viewNote: state.view ? `map view · ${state.filtered.length.toLocaleString('en-CA')} in the full selection` : '',
    manifest: state.bundle?.manifest || null,
    chips: describeFilters(state.filters, state.bundle?.manifest),
    cycle: state.bundle?.manifest?.cycles?.last || null,
    published: state.bundle ? dateLabel(state.bundle.manifest.generated_at) : null,
  }),
  onFlyer: (record) => flyers.open(record),
  onSnapshot: (record) => flyers.open(record, { kind: 'snapshot' }),
});

const analysis = initAnalysis({
  getContext: () => ({
    bundle: state.bundle,
    rows: state.shown,
    marketLabel: state.filters.market === 'current'
      ? `on the market ${state.bundle?.manifest?.cycles?.last || ''}`
      : 'all records',
  }),
});

const filters = initFiltersPanel({
  onChange(next) {
    state.filters = next;
    // A sidebar change is the one moment refitting the map is welcome.
    refilter({ fitMap: true });
    syncAreaSelection();
  },
});

// Places the subject box can resolve. Built on the first lookup, not on
// connect: parsing 232k address points takes ~0.4 s, and most visits never
// type a subject. Rebuilt when a different bundle is loaded.
let subjectIndex = null;
let subjectIndexFor = null;
async function findSubject(query) {
  if (!state.bundle) return [];
  if (!subjectIndex || subjectIndexFor !== state.bundle) {
    let points = '';
    try {
      points = (await getFile(FILES.addresses))?.text || '';
    } catch { /* an older folder: listings only */ }
    subjectIndex = buildSubjectIndex(points, state.bundle.records);
    subjectIndexFor = state.bundle;
  }
  return lookupSubject(query, subjectIndex);
}

// The map is created lazily: MapLibre is ~800 kB and there is nothing to
// plot until a folder is connected.
let map = null;
function ensureMap() {
  if (map) return map;
  map = initMapView({
    container: 'map',
    onAreaToggle(kind, name) {
      // The reverse direction: clicking an area on the map toggles it in
      // the sidebar picker, so the two never disagree.
      const key = AREA_FILTER[kind];
      if (!key) return;
      const current = state.filters[key] || [];
      const next = current.includes(name)
        ? current.filter((v) => v !== name)
        : [...current, name];
      filters.set({ ...state.filters, [key]: next });
    },
    onShapesChange(shapes) {
      state.shapes = normalizeShapes(shapes);
      refilter();          // no refit: the user drew this on the map
    },
    onSubjectChange(subject) {
      state.subject = subject;
      refilter();
    },
    lookupSubject: findSubject,
  });
  map.onViewChange((bounds) => { state.view = bounds; applyView(); });
  return map;
}

function syncAreaSelection() {
  if (!map) return;
  for (const [kind, key] of Object.entries(AREA_FILTER)) {
    map.setAreaSelection(kind, state.filters[key] || []);
  }
}

/** Everything the sidebar cannot express: drawn shapes and a subject
 *  radius, both applied to the already-filtered rows. */
function applyMapFilters(rows) {
  let out = rows;
  if (state.shapes.length) {
    out = out.filter((r) => r.latitude != null && r.longitude != null
      && passesShapeFilter({ lat: r.latitude, lng: r.longitude }, state.shapes));
  }
  if (state.subject && state.subject.radiusKm > 0) {
    const circle = [{
      kind: 'circle', mode: 'include',
      center: { lat: state.subject.lat, lng: state.subject.lng },
      radiusKm: state.subject.radiusKm,
    }];
    out = out.filter((r) => r.latitude != null && r.longitude != null
      && passesShapeFilter({ lat: r.latitude, lng: r.longitude }, circle));
  }
  return out;
}

function refilter({ fitMap = false } = {}) {
  if (!state.bundle) {
    state.filtered = [];
    state.shown = [];
    results.render([]);
    map?.setRows([]);
    return;
  }
  annotateDistance(state.bundle.records, state.subject);
  const sidebar = applyFilters(state.bundle.records, state.filters, state.bundle.manifest);
  state.filtered = applyMapFilters(sidebar);
  map?.setRows(state.filtered, { fit: fitMap });
  applyView();
}

/** The table / count line / Analysis set: the filtered records inside the
 *  map's viewport while it is followed, else all of them. */
function applyView() {
  const v = state.view;
  state.shown = v
    ? state.filtered.filter((r) => r.latitude != null && r.longitude != null
      && r.longitude >= v.w && r.longitude <= v.e && r.latitude >= v.s && r.latitude <= v.n)
    : state.filtered;
  results.render(state.shown);
  // Charts are rebuilt only while the tab is open; otherwise the next
  // open does it. Plot is ~400 kB and most visits never open it.
  analysis.invalidate();
}

const tabs = initTabs({
  onChange(tab) {
    // The Analysis settings belong to that view, so they show only with it.
    const $settings = $('an-settings');
    if ($settings) $settings.hidden = tab !== 'analysis' || !state.bundle;
    analysis.setOpen(tab === 'analysis');
    // MapLibre measures its container once. Created or last drawn while
    // Explore was hidden, it would come back as a grey, zero-sized canvas.
    if (tab === 'explore') map?.resize();
  },
});

const panel = initConnectPanel({
  setStatus,
  onBundle(bundle) {
    state.bundle = bundle;
    renderSummary(bundle);
    const published = $('tabs-published');
    if (published) {
      published.textContent = bundle?.manifest?.generated_at
        ? `Published ${dateLabel(bundle.manifest.generated_at)}` : '';
    }
    // Tabs first, so Explore is on screen before MapLibre measures it.
    tabs.setConnected(Boolean(bundle));
    if (!bundle) $('an-settings').hidden = true;
    if (bundle) ensureMap();
    filters.setRecords(bundle?.records || [], bundle?.manifest || null);
    refilter({ fitMap: Boolean(bundle) });
    syncAreaSelection();
    // On a fresh import the panel narrates its own progress; this is for
    // the other route in — reopening the page with a folder already
    // connected, where the line would otherwise still invite you to
    // connect one.
    if (!bundle) {
      setStatus('Connect a folder to begin.');
    } else {
      const n = Number(bundle.manifest?.counts?.records || 0).toLocaleString('en-CA');
      setStatus(`${n} records loaded from the connected folder.`);
    }
  },
});

// Sidebar "Download Word / Excel (charts)": the Analysis charts, one per page
// / worksheet, as on every site tab. The charts only exist once Analysis has
// drawn them, so the click opens it first.
for (const [id, kind] of [['an-download-docx', 'docx'], ['an-download-xlsx', 'xlsx']]) {
  $(id)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!state.bundle) { setStatus('Connect a folder first.'); return; }
    tabs.show('analysis');
    await analysis.ready();
    const { exportCards } = await import('../../src/subapp-chart-card.js');
    await exportCards(btn, kind, [...document.querySelectorAll('#an-charts .chart-card')], 'CommercialDashboard');
  });
}

// Sidebar jump list (Analysis › Sections), as on the Cap Rates / Johnson tabs.
document.querySelector('.hs-jump-list')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-jump]');
  if (b) document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

const build = $('build-id');
if (build) build.textContent = `build ${__APP_COMMIT__} · ${__APP_BUILD_TIME__.slice(0, 10)}`;

// Dev/test handle: lets a headless browser drive an import without the
// folder picker, which automation cannot operate. It goes through the
// panel's own refresh rather than around it, so what the check sees is
// the same render path a real folder pick produces.
//
// VITE_VERIFY builds it into a PRODUCTION bundle as well, which is the
// only way to check the built site. That gap is not theoretical: the
// MapLibre worker 404 that left the deployed map blank could not be seen
// from the dev server, where the worker resolves out of node_modules.
// A real deploy never sets VITE_VERIFY.
if (import.meta.env?.DEV || import.meta.env?.VITE_VERIFY === '1') {
  window.__app = {
    state,
    setStatus,
    async importFiles(files) {
      const { importFromFileList } = await import('./lib/store.js');
      await importFromFileList(files);
      await panel.refresh();
      return state.bundle;
    },
    setFilters(next) {
      filters.set(next);
      return state.filtered.length;
    },
    /** Connect a real FileSystemDirectoryHandle — the OPFS root in checks,
     *  which exercises the same path a folder pick does. */
    async connectDirectory(handle) {
      const store = await import('./lib/store.js');
      await store.putMeta('dirHandle', handle);
      const summary = await store.importFromDirectory(handle, { force: true });
      await panel.refresh();
      return summary;
    },
    map: () => map,
    analysis,
    showTab: (tab) => tabs.show(tab),
    findSubject,
    refreshPanel: () => panel.refresh(),
    openFlyer: (record) => flyers.open(record),
    openSnapshot: (record) => flyers.open(record, { kind: 'snapshot' }),
    setShapes(shapes) {
      state.shapes = normalizeShapes(shapes);
      map?.setShapes(state.shapes);
      refilter();
      return state.filtered.length;
    },
  };
}
