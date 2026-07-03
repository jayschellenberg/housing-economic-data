/*
 * Comparison-Tables map — appears only when the comparison areas all sit within
 * one CMA. It shades that CMA's zones/neighbourhoods by a chosen rental metric
 * and outlines the compared areas, for spatial context beside the tables.
 * Clicking toggles areas against the tab's fixed slots: an outlined area is
 * removed (later slots shift up so Second/Third stay filled), any other area
 * fills — or replaces — the optional Fourth slot. Shading comes from
 * rental_summary.json.
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

export function initTablesMap({ geographies, onSelect }) {
  const core = makeZoneChoroplethMap({
    host: 'tbl-map',
    geographies,
    onSelect,
    metrics: METRICS,
    loadSummary: loadRentalSummary,
    pickerId: 'tbl-map-metric',
    source: 'Boundaries: adapted from CMHC Rental Market Survey geographies; not endorsed by CMHC',
    filePrefix: 'tables',
    clickHint: 'Click an outlined area to remove it; click another area to fill the Fourth slot.',
  });
  return { render: (areas) => core.draw(comparedAreasTarget(areas)) };
}
