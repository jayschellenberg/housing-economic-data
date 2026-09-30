/*
 * bands.js — the bedroom-band palette and labels shared by the map, the
 * legend, the analysis charts and the KPI tiles, so a band is the same
 * colour everywhere. Order matches policy.BEDROOM_BANDS.
 */

export const BAND_ORDER = Object.freeze(['studio', '1br', '2br', '3br', '4plus']);

export const BAND_COLORS = Object.freeze({
  studio: '#7c3aed', '1br': '#2a78d6', '2br': '#1baf7a', '3br': '#eb6834', '4plus': '#b42318', unknown: '#898781',
});

export const BAND_LABELS = Object.freeze({
  studio: 'Studio', '1br': '1 BR', '2br': '2 BR', '3br': '3 BR', '4plus': '4+ BR', unknown: 'Unknown', all: 'All',
});
