// Shared number formatters.
//
// These were copy-pasted (identically) across census.js, housing.js,
// affordability.js, rtb.js and compare.js; this module is the single source of
// truth so the missing-value convention stays consistent everywhere.
//
// MISSING-VALUE CONVENTION: null / NaN / ±Infinity are "missing". By default
// they render as `**` — the app-wide table marker (see the "missing-data
// asterisks" note). Callers that need a different marker pass it as the second
// argument: indicator charts use `—`, and some callers pass `null` to defer the
// marker to a downstream renderer (e.g. compare.js builds a matrix and paints
// blanks later).
//
// PERCENT GOTCHA — read before reusing: there are TWO different "1-decimal
// percent" semantics and they must never share a name:
//   • fPct1     — the value is ALREADY a percent (e.g. 5.2  → "5.2%")
//   • fPctFrac1 — the value is a FRACTION       (e.g. 0.052 → "5.2%")
// Picking the wrong one silently multiplies by 100 (or fails to). Census rows
// hold fractions; rental/affordability metrics hold already-computed percents.

// Universal missing-value predicate: null / NaN / ±Infinity are "missing".
export const miss = (v) => v == null || !Number.isFinite(Number(v));

// Integer with thousands separators: 12345 → "12,345".
export const fInt = (v, missing = '**') =>
  miss(v) ? missing : Number(v).toLocaleString();

// Whole dollars: 1234.5 → "$1,235".
export const fUsd = (v, missing = '**') =>
  miss(v) ? missing : `$${Math.round(Number(v)).toLocaleString()}`;

// One decimal place, no unit: 4.27 → "4.3".
export const fDec1 = (v, missing = '**') =>
  miss(v) ? missing : Number(v).toFixed(1);

// Value is ALREADY a percent, one decimal: 5.2 → "5.2%".
export const fPct1 = (v, missing = '**') =>
  miss(v) ? missing : `${Number(v).toFixed(1)}%`;

// Value is a FRACTION, rendered as a whole-number percent: 0.27 → "27%".
export const fPctFrac0 = (v, missing = '**') =>
  miss(v) ? missing : `${Math.round(Number(v) * 100)}%`;

// Value is a FRACTION, rendered as a one-decimal percent: 0.052 → "5.2%".
export const fPctFrac1 = (v, missing = '**') =>
  miss(v) ? missing : `${(Number(v) * 100).toFixed(1)}%`;

// Value is already on a 0–100 scale, rendered as a whole-number percent:
// 32.6 → "33%" (used for shelter-cost-to-income ratios).
export const fPctInt = (v, missing = '**') =>
  miss(v) ? missing : `${Math.round(Number(v))}%`;

// Indicator / economic-series formatters keyed by the series `units`. These
// render missing values as "—" (the indicators convention, not the "**" of the
// tables above). Shared by indicators.js (KPI tiles) and indicator-chart.js
// (chart axis + latest-value chip).
export const INDICATOR_FMT = {
  percent:            (v) => v == null ? '—' : `${Number(v).toFixed(2)}%`,
  dollar:             (v) => v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}`,
  dollar_millions:    (v) => v == null ? '—' : `$${(Number(v) / 1e6).toFixed(1)}M`,
  // Agricultural commodity prices: crops in $/tonne (whole dollars), livestock
  // in $/hundredweight (cents matter at these levels).
  dollar_per_tonne:   (v) => v == null ? '—' : `$${Math.round(Number(v)).toLocaleString()}/t`,
  dollar_per_cwt:     (v) => v == null ? '—' : `$${Number(v).toFixed(2)}/cwt`,
  index:              (v) => v == null ? '—' : Number(v).toFixed(1),
  units:              (v) => v == null ? '—' : Math.round(Number(v)).toLocaleString(),
  persons:            (v) => v == null ? '—' : Math.round(Number(v)).toLocaleString(),
  // StatsCan "Persons in thousands": cansim's val_norm already applied the ×1000
  // scalar, so the value is raw persons — render as millions (21,034,500 → "21.0M").
  persons_thousands:  (v) => v == null ? '—' : `${(Number(v) / 1e6).toFixed(1)}M`,
  ratio:              (v) => v == null ? '—' : Number(v).toFixed(2),
  balance_of_opinion: (v) => v == null ? '—' : `${Number(v).toFixed(0)}`,
};

// Formatter for a series' `units`, defaulting to a plain string cast.
export const indicatorFmt = (units) => INDICATOR_FMT[units] || ((v) => String(v));
