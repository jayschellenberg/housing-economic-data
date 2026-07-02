/*
 * Housing Starts survey-zone map — a metric choropleth over the shared
 * zone-choropleth helper. Follows the Starts tab's (geoLevel, geoUid): when a
 * survey zone, neighbourhood or surveyed CMA is selected it shades that CMA's
 * zones (or neighbourhoods) by a Scss metric, and doubles as a click-to-select
 * picker (a polygon click drives the tab's geo dropdowns). Shading comes from
 * starts_summary.json (build-starts-summary.mjs).
 *
 * Boundaries: adapted from CMHC RMS survey geographies (r/21 build step) — the
 * Starts survey shares the same zone/neighbourhood geography.
 */

import { makeZoneChoroplethMap, singleGeoTarget } from './zone-choropleth.js';
import { loadStartsSummary } from './starts-summary.js';

// Scss series the map can shade by (all whole-unit counts).
const METRICS = [
  { key: 'Starts',               label: 'Starts',               kind: 'int' },
  { key: 'Completions',          label: 'Completions',          kind: 'int' },
  { key: 'Under Construction',   label: 'Under construction',   kind: 'int' },
  { key: 'Absorbed Units',       label: 'Absorbed units',       kind: 'int' },
  { key: 'Unabsorbed Inventory', label: 'Unabsorbed inventory', kind: 'int' },
];

export function initStartsMap({ geographies, onSelect }) {
  const core = makeZoneChoroplethMap({
    host: 'hs-map',
    geographies,
    onSelect,
    metrics: METRICS,
    loadSummary: loadStartsSummary,
    pickerId: 'hs-map-metric',
    source: 'Boundaries: adapted from CMHC Rental Market Survey geographies; not endorsed by CMHC',
    filePrefix: 'starts',
  });
  return { render: (state) => core.draw(singleGeoTarget(state)) };
}
