/*
 * evidence.js — the archived-page viewer.
 *
 * Published evidence HTML is what the scraper saw, with a
 * `script-src 'none'` CSP meta injected at publish time. It is shown in
 * a <dialog> inside an <iframe sandbox> with NO flags — scripts, forms
 * and same-origin access all off — so even a page that lied about its
 * CSP cannot run anything. "Open in tab" hands the same bytes to a new
 * tab as a blob URL (the meta CSP still applies there); "Download" saves
 * the file for a report appendix.
 */

import { readEvidence } from './lib/store.js';
import { downloadBlob } from './exports.js';

export function initEvidenceViewer({ setStatus } = {}) {
  const $ = (id) => document.getElementById(id);
  const $dlg = $('evidence-dialog');
  const $title = $('evidence-title');
  const $meta = $('evidence-meta');
  const $frame = $('evidence-frame');
  const $open = $('evidence-open');
  const $save = $('evidence-save');
  const $close = $('evidence-close');
  const say = (m) => { if (typeof setStatus === 'function') setStatus(m); };

  let current = null;   // { html, path, name }
  let blobUrl = null;

  function release() {
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    $frame.srcdoc = '';
    current = null;
  }

  $close?.addEventListener('click', () => $dlg.close());
  $dlg?.addEventListener('close', release);
  $dlg?.addEventListener('click', (e) => { if (e.target === $dlg) $dlg.close(); });

  $open?.addEventListener('click', () => {
    if (!current) return;
    if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([current.html], { type: 'text/html' }));
    window.open(blobUrl, '_blank', 'noopener');
  });
  $save?.addEventListener('click', () => {
    if (!current) return;
    downloadBlob(new Blob([current.html], { type: 'text/html' }), current.name);
  });

  return {
    /** Open the archived page for a listing record. */
    async open(l) {
      if (!l?.evidence_path) { say('This listing has no archived page in the bundle.'); return; }
      say('Opening archived page…');
      let html;
      try {
        html = await readEvidence(l.evidence_path);
      } catch (err) {
        say(err.message);
        return;
      }
      release();
      current = { html, path: l.evidence_path, name: l.evidence_path.split('/').pop() || 'listing.html' };
      $title.textContent = l.address || l.title || `Listing ${l.id}`;
      $meta.textContent = `${l.source} · archived ${l.evidence_path.split('/')[1] || ''} · ${l.evidence_path}`;
      $frame.srcdoc = html;
      if (typeof $dlg.showModal === 'function') $dlg.showModal(); else $dlg.setAttribute('open', '');
      say('');
    },
  };
}
