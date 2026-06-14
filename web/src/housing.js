/*
 * Housing Stock view — 2021 Census dwelling condition + period of construction
 * (StatsCan table 98-10-0233) by area. Loads census_housing.json, lets the user
 * pick an area, and renders an age-profile table + a condition-profile table
 * with shares. Manitoba & Saskatchewan include every municipality (CSD); other
 * provinces are province-level only. Source data produced by r/07.
 */

export async function initHousing() {
  const $area     = document.getElementById('hsk-area');
  const $headline = document.getElementById('hsk-headline');
  const $tables   = document.getElementById('hsk-tables');
  if (!$area || !$tables) return;

  const data = await fetch('./data/housing/census_housing.json')
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!data || !Array.isArray(data.areas)) {
    $tables.innerHTML = '<p class="text-sm text-red-700">Census housing data not found. Run r/07_scrape_census_housing.R.</p>';
    return;
  }

  const byUid = new Map(data.areas.map(a => [a.uid, a]));

  // Grouped dropdown — Canada, provinces/territories, then MB + SK municipalities.
  const pick = (test) => data.areas.filter(test).sort((a, b) => a.name.localeCompare(b.name));
  const country = data.areas.filter(a => a.level === 'country');
  const provs   = pick(a => a.level === 'province');
  const mb      = pick(a => a.level === 'csd' && a.prov === '46');
  const sk      = pick(a => a.level === 'csd' && a.prov === '47');
  const opt   = (a) => `<option value="${a.uid}">${escapeHtml(a.name)}</option>`;
  const group = (label, arr) => arr.length ? `<optgroup label="${escapeHtml(label)}">${arr.map(opt).join('')}</optgroup>` : '';
  $area.innerHTML =
    country.map(opt).join('') +
    group('Provinces & Territories', provs) +
    group('Manitoba municipalities', mb) +
    group('Saskatchewan municipalities', sk);
  // Default to Winnipeg (Jason's home market) if present, else Canada.
  $area.value = byUid.has('4611040') ? '4611040' : (country[0]?.uid || $area.options[0]?.value);

  let lastTables = [];

  function render() {
    const a = byUid.get($area.value);
    if (!a) return;
    const total = a.total || 0;
    const share = (v) => (total > 0 && v != null) ? (v / total * 100) : null;
    const fmtN  = (v) => v == null ? '**' : Number(v).toLocaleString();
    const fmtP  = (v) => v == null ? '—'  : `${v.toFixed(1)}%`;

    // Headline: total dwellings + the two figures appraisers reach for first.
    const major     = a.condition?.[2];          // "Major repairs needed"
    const since2016 = a.age?.[a.age.length - 1];  // last band = 2016–2021
    $headline.innerHTML = `
      <div class="cmhc-hsk-title">${escapeHtml(a.name)} — housing stock <span>(2021 Census)</span></div>
      <div class="cmhc-hsk-stats">
        <span><strong>${fmtN(total)}</strong> private dwellings</span>
        <span><strong>${fmtP(share(major))}</strong> need major repairs</span>
        <span><strong>${fmtP(share(since2016))}</strong> built 2016–2021</span>
      </div>`;

    const ageRows  = data.periodLabels.map((lbl, i)    => ({ label: lbl, n: a.age?.[i],       p: share(a.age?.[i]) }));
    const condRows = data.conditionLabels.map((lbl, i) => ({ label: lbl, n: a.condition?.[i], p: share(a.condition?.[i]) }));

    const tableHtml = (title, rows) => {
      const body = rows.map(r =>
        `<tr><td>${escapeHtml(r.label)}</td><td>${fmtN(r.n)}</td><td>${fmtP(r.p)}</td></tr>`).join('');
      return `<section class="cmhc-table-block">
        <div class="cmhc-table-title">${escapeHtml(title)}</div>
        <table class="cmhc-table">
          <thead><tr><th>Category</th><th>Dwellings</th><th>Share</th></tr></thead>
          <tbody>${body}<tr class="cmhc-table-summary cmhc-table-summary-top"><td>Total</td><td>${fmtN(total)}</td><td>100.0%</td></tr></tbody>
        </table></section>`;
    };
    $tables.innerHTML =
      tableHtml('Age — period of construction', ageRows) +
      tableHtml('Condition — repairs needed', condRows);

    // Export model (re-used by both the Excel and clipboard buttons).
    const toExport = (titleSuffix, rows) => ({
      title: `${a.name} — ${titleSuffix}`,
      columns: ['Dwellings', 'Share'],
      rows: rows.map(r => ({ area: r.label, values: [fmtN(r.n), fmtP(r.p)] }))
              .concat([{ area: 'Total', values: [fmtN(total), '100.0%'] }]),
    });
    lastTables = [
      toExport('Period of construction', ageRows),
      toExport('Dwelling condition', condRows),
    ];
  }

  $area.addEventListener('change', render);
  render();

  // --- Exports ---------------------------------------------------------------
  document.getElementById('hsk-download-xlsx')?.addEventListener('click', async () => {
    if (!lastTables.length) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    await exportTablesToExcel(
      lastTables.map(t => ({ ...t, dwellingSuffix: '' })),
      { filename: `Census_HousingStock_${new Date().toISOString().slice(0, 10)}.xlsx`,
        maxYear: 2021, titleNote: '— 2021 Census (StatsCan 98-10-0233)' });
  });
  document.getElementById('hsk-copy')?.addEventListener('click', () => {
    const html = lastTables.map(t =>
      `<h4>${escapeHtml(t.title)}</h4>` +
      `<table border="1" cellspacing="0" cellpadding="3"><tr><th>Category</th>${t.columns.map(c => `<th>${c}</th>`).join('')}</tr>` +
      t.rows.map(r => `<tr><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`).join('') +
      '</table>').join('<br>');
    copyHtml(html);
  });
}

function copyHtml(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    navigator.clipboard.write([new ClipboardItem({
      'text/html':  new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  } catch {
    navigator.clipboard?.writeText(text);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
