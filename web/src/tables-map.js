/*
 * Comparison-Tables map — appears only when the comparison areas all sit within
 * one CMA. It shades that CMA's zones/neighbourhoods by a chosen rental metric
 * and outlines the compared areas, for spatial context beside the tables. This
 * one is display-only (no click-to-select — the tables have fixed area slots).
 * Shading comes from rental_summary.json.
 *
 * Boundaries: adapted from CMHC RMS survey geographies (r/21 build step).
 */

import { makeZoneChoroplethMap, comparedAreasTarget } from './zone-choropleth.js';
import { loadRentalSummary } from './rental-summary.js';

// The rental measures the tables report.
const METRICS = [
  { key: 'Median Rent',   label: 'Median rent',   kind: 'usd' },
  { key: 'Average Rent',  label: 'Average rent',  kind: 'usd' },
  { key: 'Vacancy Rate',  label: 'Vacancy rate',  kind: 'pct' },
];

export function initTablesMap({ geographies }) {
  const core = makeZoneChoroplethMap({
    host: 'tbl-map',
    geographies,
    metrics: METRICS,
    loadSummary: loadRentalSummary,
    pickerId: 'tbl-map-metric',
    source: 'Boundaries: adapted from CMHC Rental Market Survey geographies; not endorsed by CMHC',
    filePrefix: 'tables',
  });
  return { render: (areas) => core.draw(comparedAreasTarget(areas)) };
}
