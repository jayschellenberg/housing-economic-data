/*
 * Rental Charts survey-zone map — a metric choropleth over the shared
 * zone-choropleth helper. Follows the charts tab's (geoLevel, geoUid): when a
 * survey zone, neighbourhood or surveyed CMA is selected it shades that CMA's
 * zones (or neighbourhoods) by a rental metric, and doubles as a click-to-select
 * picker (a polygon click drives filters.setGeo, keeping the dropdowns + URL in
 * sync). Shading comes from rental_summary.json (build-rental-summary.mjs).
 *
 * Boundaries: adapted from CMHC RMS survey geographies (r/21 build step).
 */

import { makeZoneChoroplethMap, singleGeoTarget } from './zone-choropleth.js';
import { loadRentalSummary } from './rental-summary.js';

// Metrics the map can shade by — same set and order as the charts' panels.
const METRICS = [
  { key: 'Median Rent',         label: 'Median rent',     kind: 'usd' },
  { key: 'Average Rent',        label: 'Average rent',    kind: 'usd' },
  { key: 'Vacancy Rate',        label: 'Vacancy rate',    kind: 'pct' },
  { key: 'Average Rent Change', label: 'Avg rent change', kind: 'pct' },
  { key: 'Rental Universe',     label: 'Rental universe', kind: 'int' },
];

export function initChartsMap({ geographies, onSelect }) {
  const core = makeZoneChoroplethMap({
    host: 'charts-map',
    geographies,
    onSelect,
    metrics: METRICS,
    loadSummary: loadRentalSummary,
    pickerId: 'charts-map-metric',
    source: 'Boundaries: adapted from CMHC Rental Market Survey geographies; not endorsed by CMHC',
    filePrefix: 'rental',
  });
  return { render: (state) => core.draw(singleGeoTarget(state)) };
}
