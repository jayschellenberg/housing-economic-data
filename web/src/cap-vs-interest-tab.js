/*
 * Cap Rates vs Interest tab (Local Data) — hosts the Cap vs Interest chart
 * that used to sit at the top of Market Indicators.
 *
 * It moved because its cap-rate half is the viewer's own local data (the
 * Cap Rates tab's folder), which is what the Local Data group is for; the
 * Market Indicators tab is public BoC / StatsCan data and stays under
 * Housing & Economic Data. The section itself is unchanged
 * (cap-vs-interest.js); this module only gives it a panel, the BoC shard it
 * draws its rate lines from, and a date range.
 */

import { buildCapVsInterest, rerenderCapVsInterest } from './cap-vs-interest.js';

const RATE_SHARD = 'mortgage_market';

// Same default window as Market Indicators: five years back from "to"
// (or from the current month when "to" is blank), until "from" is set by hand.
function autoFromFor(toVal) {
  let y, mo;
  if (toVal && /^\d{4}-\d{2}$/.test(toVal)) {
    [y, mo] = toVal.split('-').map(Number);
  } else {
    const d = new Date();
    y = d.getFullYear();
    mo = d.getMonth() + 1;
  }
  return `${y - 5}-${String(mo).padStart(2, '0')}`;
}

let initialised = false;

export async function initCapVsInterestTab() {
  if (initialised) return;
  initialised = true;
  const $grid = document.getElementById('cvi-grid');
  if (!$grid) return;

  let shard = null;
  try {
    const r = await fetch(`./data/indicators/${RATE_SHARD}.json`);
    shard = r.ok ? await r.json() : null;
  } catch { shard = null; }
  if (!shard?.records?.length) {
    $grid.innerHTML = '<p class="text-sm text-red-700">Bank of Canada rate data not found. Re-run the indicators refresh.</p>';
    return;
  }

  const state = { monthFrom: autoFromFor(null), monthTo: null, monthFromLocked: false };
  const $from = document.getElementById('cvi-month-from');
  const $to = document.getElementById('cvi-month-to');
  if ($from) $from.value = state.monthFrom;

  buildCapVsInterest({ [RATE_SHARD]: shard }, state, { container: '#cvi-grid' });

  $from?.addEventListener('change', () => {
    if ($from.value) { state.monthFrom = $from.value; state.monthFromLocked = true; }
    else { state.monthFromLocked = false; state.monthFrom = autoFromFor(state.monthTo); $from.value = state.monthFrom; }
    rerenderCapVsInterest();
  });
  $to?.addEventListener('change', () => {
    state.monthTo = $to.value || null;
    if (!state.monthFromLocked) {
      state.monthFrom = autoFromFor(state.monthTo);
      if ($from) $from.value = state.monthFrom;
    }
    rerenderCapVsInterest();
  });
}
