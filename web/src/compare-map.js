/*
 * Compare-Areas map — appears only when the areas being compared all sit within
 * one CMA (e.g. several Winnipeg zones). It shades that CMA's zones/
 * neighbourhoods by a chosen rental metric and outlines the compared areas, so
 * the comparison has spatial context. Clicking a polygon toggles it in or out of
 * the comparison. Shading comes from rental_summary.json.
 *
 * Boundaries: adapted from CMHC RMS survey geographies (r/21 build step).
 */

import { makeZoneChoroplethMap, comparedAreasTarget } from './zone-choropleth.js';
import { loadRentalSummary } from './rental-summary.js';

// The metrics the Compare tab plots (no Rental Universe here).
const METRICS = [
  { key: 'Median Rent',         label: 'Median rent',     kind: 'usd' },
  { key: 'Average Rent',        label: 'Average rent',    kind: 'usd' },
  { key: 'Vacancy Rate',        label: 'Vacancy rate',    kind: 'pct' },
  { key: 'Average Rent Change', label: 'Avg rent change', kind: 'pct' },
];

export function initCompareMap({ geographies, onSelect }) {
  const core = makeZoneChoroplethMap({
    host: 'cmp-map',
    geographies,
    onSelect,
    metrics: METRICS,
    loadSummary: loadRentalSummary,
    pickerId: 'cmp-map-metric',
    source: 'Boundaries: adapted from CMHC Rental Market Survey geographies; not endorsed by CMHC',
    filePrefix: 'compare',
    clickHint: 'Click an area to add or remove it from the comparison.',
  });
  return { render: (areas) => core.draw(comparedAreasTarget(areas)) };
}
