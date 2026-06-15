/*
 * Dwelling Type view — occupied private dwellings by structural type
 * (single-detached, semi, row, apartment <5 / 5+ storeys, duplex, other
 * attached, movable) for Canada + provinces + Manitoba & Saskatchewan CMAs/CAs.
 * Loads dwelling_types.json (r/10). Multi-year-ready: a census-year selector
 * appears once more than one year is present. Source data: StatsCan census.
 */

export async function initDwelling() {
  const $area = document.getElementById('dt-area');
  const $year = document.getElementById('dt-year');
  const $headline = document.getElementById('dt-headline');
  const $tables = document.getElementById('dt-tables');
  if (!$area || !$tables) return;

  const data = await fetch('./data/housing/dwelling_types.json')
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!data || !Array.isArray(data.areas)) {
    $tables.innerHTML = '<p class="text-sm text-red-700">Dwelling-type data not found. Run r/10_dwelling_types.R.</p>';
    return;
  }

  const byUid = new Map(data.areas.map(a => [a.uid, a]));
  const years = (data.censusYears || []).map(String);
  const fmtN = (v) => v == null ? '**' : Number(v).toLocaleString();
  const fmtP = (v) => v == null ? '—'  : `${v.toFixed(1)}%`;

  // Area dropdown — Canada, provinces, then MB/SK CMAs/CAs.
  const pick = (test) => data.areas.filter(test).sort((a, b) => a.name.localeCompare(b.name));
  const country = data.areas.filter(a => a.level === 'country');
  const opt   = (a) => `<option value="${a.uid}">${escapeHtml(a.name)}</option>`;
  const group = (label, arr) => arr.length ? `<optgroup label="${escapeHtml(label)}">${arr.map(opt).join('')}</optgroup>` : '';
  $area.innerHTML =
    country.map(opt).join('') +
    group('Provinces & Territories', pick(a => a.level === 'province')) +
    group('Manitoba CMAs / CAs',     pick(a => a.level === 'cma' && a.prov === '46')) +
    group('Saskatchewan CMAs / CAs', pick(a => a.level === 'cma' && a.prov === '47'));
  $area.value = byUid.has('602') ? '602' : (country[0]?.uid || $area.options[0]?.value);

  // Year radios (only shown when there's more than one census year).
  if (years.length > 1) {
    $year.innerHTML = years.map((y, i) =>
      `<label class="flex items-center gap-1"><input type="radio" name="dtYear" value="${y}" ${i === years.length - 1 ? 'checked' : ''}/> ${y}</label>`).join('');
  } else {
    $year.closest('section').hidden = true;
  }
  const yearVal = () => [...document.querySelectorAll('input[name=dtYear]')].find(r => r.checked)?.value || years[years.length - 1];

  let lastTable = null;
  function render() {
    const a = byUid.get($area.value);
    const year = yearVal();
    const yd = a?.census?.[year];
    if (!yd) {
      $headline.innerHTML = `<div class="cmhc-hsk-title">${escapeHtml(a?.name || '')}</div>`;
      $tables.innerHTML = `<p class="text-sm text-neutral-600">No ${year} dwelling-type data for this area.</p>`;
      lastTable = null;
      return;
    }
    const total = yd.total || 0;
    const labels = data.typeLabels[year];
    const share = (v) => (total > 0 && v != null) ? (v / total * 100) : null;
    const rows = labels.map((lbl, i) => ({ label: lbl, n: yd.types?.[i], p: share(yd.types?.[i]) }));

    // Apartment share = sum of the apartment-type rows.
    const aptN = labels.reduce((s, lbl, i) => s + (/apartment/i.test(lbl) ? (yd.types?.[i] || 0) : 0), 0);
    const single = rows.find(r => /single-detached/i.test(r.label));
    $headline.innerHTML = `
      <div class="cmhc-hsk-title">${escapeHtml(a.name)} — dwellings by type <span>(${year} Census)</span></div>
      <div class="cmhc-hsk-stats">
        <span><strong>${fmtN(total)}</strong> private dwellings</span>
        <span><strong>${fmtP(single ? single.p : null)}</strong> single-detached</span>
        <span><strong>${fmtP(share(aptN))}</strong> apartments</span>
      </div>`;

    const body = rows.map(r =>
      `<tr><td>${escapeHtml(r.label)}</td><td>${fmtN(r.n)}</td><td>${fmtP(r.p)}</td></tr>`).join('');
    $tables.innerHTML = `<section class="cmhc-table-block">
      <div class="cmhc-table-title">Structural type of dwelling — ${year}</div>
      <table class="cmhc-table">
        <thead><tr><th>Structural type</th><th>Dwellings</th><th>Share</th></tr></thead>
        <tbody>${body}<tr class="cmhc-table-summary cmhc-table-summary-top"><td>Total</td><td>${fmtN(total)}</td><td>100.0%</td></tr></tbody>
      </table></section>`;

    lastTable = {
      title: `${a.name} — dwellings by structural type (${year})`,
      columns: ['Dwellings', 'Share'],
      rows: rows.map(r => ({ area: r.label, values: [fmtN(r.n), fmtP(r.p)] }))
              .concat([{ area: 'Total', values: [fmtN(total), '100.0%'] }]),
    };
  }

  $area.addEventListener('change', render);
  $year.addEventListener('change', render);
  render();

  document.getElementById('dt-download-xlsx')?.addEventListener('click', async () => {
    if (!lastTable) return;
    const { exportTablesToExcel } = await import('./excel-export.js');
    await exportTablesToExcel([{ ...lastTable, dwellingSuffix: '' }],
      { filename: `Census_DwellingType_${new Date().toISOString().slice(0, 10)}.xlsx`,
        maxYear: 2021, titleNote: '— Census of Population (StatsCan)' });
  });
  document.getElementById('dt-copy')?.addEventListener('click', () => {
    if (!lastTable) return;
    const t = lastTable;
    const html = `<h4>${escapeHtml(t.title)}</h4>` +
      `<table border="1" cellspacing="0" cellpadding="3"><tr><th>Structural type</th>${t.columns.map(c => `<th>${c}</th>`).join('')}</tr>` +
      t.rows.map(r => `<tr><td>${escapeHtml(r.area)}</td>${r.values.map(v => `<td>${v}</td>`).join('')}</tr>`).join('') + '</table>';
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    try {
      navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
    } catch { navigator.clipboard?.writeText(text); }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
