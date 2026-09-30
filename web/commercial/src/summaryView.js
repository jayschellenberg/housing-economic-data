/*
 * summaryView.js — renders the overview from a parsed bundle. All the
 * arithmetic lives in lib/summary.js; this only puts numbers on screen.
 */

import {
  bySpaceType, byBrokerage, byMunicipality, headline, excludedCount, policy,
} from './lib/summary.js';
import { restrictedColumns } from './lib/bundle.js';
import { cycleLabel } from './connectPanel.js';

const $ = (id) => document.getElementById(id);
const MISSING = '**';   // the site's table convention for no value
const fmt = (n) => (n == null ? MISSING : Number(n).toLocaleString('en-CA'));
const money = (n) => (n == null ? MISSING : `$${Number(n).toLocaleString('en-CA', { maximumFractionDigits: 0 })}`);
const rate = (n) => (n == null ? MISSING : `$${Number(n).toFixed(2)}`);
const sf = (n) => (n == null ? MISSING : `${Number(n).toLocaleString('en-CA', { maximumFractionDigits: 0 })} sf`);

function tile(label, value, note) {
  const li = document.createElement('li');
  const v = document.createElement('span'); v.className = 'tile-value'; v.textContent = value;
  const l = document.createElement('span'); l.className = 'tile-label'; l.textContent = label;
  li.append(v, l);
  if (note) {
    const n = document.createElement('span'); n.className = 'tile-note'; n.textContent = note;
    li.append(n);
  }
  return li;
}

function row(cells) {
  const tr = document.createElement('tr');
  for (const [text, cls] of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    tr.appendChild(td);
  }
  return tr;
}

function fill(tableId, rows) {
  const tbody = $(tableId)?.querySelector('tbody');
  if (!tbody) return;
  tbody.textContent = '';
  for (const r of rows) tbody.appendChild(r);
}

export function renderSummary(bundle) {
  const section = $('overview');
  if (!section) return;
  if (!bundle) { section.hidden = true; return; }

  const { manifest, records } = bundle;
  const h = headline(records, manifest);

  const $tiles = $('tiles');
  $tiles.textContent = '';
  $tiles.append(
    // First, because every other number here is only as current as this.
    // ISO, not "Sep 22, 2026": the long form wrapped to two lines and made
    // every tile in the row taller. The tab bar carries the readable one.
    tile('last published', String(manifest?.generated_at || '').slice(0, 10) || '—',
      `${cycleLabel(h.cycleLast)} cycle`),
    tile('on the market', fmt(h.current), `as of ${cycleLabel(h.cycleLast)}`),
    tile('records tracked', fmt(h.records), `${h.cycleCount} monthly cycles`),
    tile('mapped', fmt(h.geocoded), `of ${fmt(h.records)} records`),
    tile('price / status runs', fmt(h.runs), `from ${cycleLabel(h.cycleFirst)}`),
    tile('flyers available', fmt(h.flyersPresent), h.flyersPresent ? 'in the connected folder' : 'not in this publish'),
  );

  const excluded = excludedCount(records, manifest);
  const band = policy(manifest).leaseRate;
  $('overview-asof').textContent =
    `Seen in the ${cycleLabel(h.cycleLast)} cycle. ${fmt(h.duplicateSpaces)} records are the same space listed by more than one brokerage.`
    + (excluded && band
      ? ` ${fmt(excluded)} implausible value${excluded === 1 ? ' is' : 's are'} left out of the medians `
        + `(a rate outside $${band[0]}–$${band[1]}/sf/yr is usually a monthly total mislabelled upstream).`
      : '');

  fill('space-table', bySpaceType(records, manifest).map((r) => row([
    [r.space_type], [fmt(r.lease), 'num'], [fmt(r.sale), 'num'],
    [rate(r.median_rate), 'num'], [money(r.median_price), 'num'], [sf(r.median_sf), 'num'],
  ])));

  fill('brokerage-table', byBrokerage(records, manifest).map((r) => row([
    [r.brokerage], [fmt(r.current), 'num'], [fmt(r.records), 'num'],
  ])));

  fill('muni-table', byMunicipality(records, manifest).map((r) => row([
    [r.municipality], [fmt(r.current), 'num'],
  ])));

  // Licensed-source notice. Shown only once a folder is connected, and
  // worded by the bundle — the deployed page says nothing about what the
  // data contains or where it came from.
  const $notice = $('restricted-notice');
  const restricted = restrictedColumns(manifest);
  if (restricted.size && manifest.restricted_notice) {
    $notice.textContent = manifest.restricted_notice;
    $notice.hidden = false;
  } else {
    $notice.hidden = true;
  }

  section.hidden = false;
}
