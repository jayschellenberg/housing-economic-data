/*
 * flyerViewer.js — opens a brokerage flyer from the connected folder.
 *
 * The PDF is read through the directory handle and shown from a blob
 * URL, so the file never leaves the machine and the page never fetches
 * anything: same contract as the rest of the app. A Download button
 * sits alongside, because a blob iframe is at the mercy of the browser's
 * built-in PDF viewer being enabled.
 *
 * Only reachable with the 'parent' layout (the folder that holds both
 * export\ and flyers\) — a directory handle cannot see its parent, so
 * connecting export\ itself forfeits flyers. The panel says so.
 */

import { readFlyer, readSnapshot } from './lib/store.js';
import { snapshotsOf } from './lib/flyerPath.js';

const $ = (id) => document.getElementById(id);

export function initFlyerViewer({ setStatus } = {}) {
  const dialog = $('flyer-dialog');
  if (!dialog) return { open: async () => {} };
  const frame = $('flyer-frame');
  const title = $('flyer-title');
  const meta = $('flyer-meta');
  const error = $('flyer-error');
  const download = $('flyer-download');
  const imageWrap = $('flyer-image-wrap');
  const image = $('flyer-image');

  let url = null;       // the blob URL currently shown
  let file = null;

  function release() {
    if (url) { URL.revokeObjectURL(url); url = null; }
    file = null;
    frame.removeAttribute('src');
    image?.removeAttribute('src');
  }

  dialog.addEventListener('close', release);
  $('flyer-close')?.addEventListener('click', () => dialog.close());

  download?.addEventListener('click', () => {
    if (!file || !url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  const picks = $('snapshot-picks');

  function fail(err) {
    // Every failure here is a thing the reader can act on: connect the
    // outer folder, wait for Dropbox, or ask for a publish with flyers.
    error.textContent = err.message;
    error.hidden = false;
    setStatus?.(err.message);
  }

  /** Show one file: a PDF in the frame, or a snapshot as an image. */
  async function show(path, { snapshot, label, recordLine }) {
    release();
    error.hidden = true;
    error.textContent = '';
    download.hidden = true;
    meta.textContent = [recordLine, snapshot ? label : null, path].filter(Boolean).join(' · ');
    try {
      file = await (snapshot ? readSnapshot(path) : readFlyer(path));
      url = URL.createObjectURL(file);
      if (snapshot) {
        image.src = url;
        image.alt = `${label}: Moody’s listing snapshot for ${title.textContent}`;
      } else {
        frame.src = url;
      }
      download.hidden = false;
      meta.textContent += ` · ${Math.round(file.size / 1024).toLocaleString('en-CA')} KB`;
    } catch (err) {
      fail(err);
    }
  }

  /**
   * Open a record's flyer (a PDF, in the iframe) or its Moody's snapshots
   * (JPEGs, as an image with a picker: New / Listed / Pending /
   * Conditional / Current — whichever exist). All read from the connected
   * folder through the directory handle, so nothing is fetched.
   */
  async function open(record, { kind = 'flyer' } = {}) {
    release();
    const snapshot = kind === 'snapshot';
    title.textContent = record.address || record.property_name || (snapshot ? 'Snapshot' : 'Flyer');
    frame.hidden = snapshot;
    if (imageWrap) imageWrap.hidden = !snapshot;
    if (picks) { picks.textContent = ''; picks.hidden = true; }
    if (!dialog.open) dialog.showModal();

    if (!snapshot) {
      await show(record.flyer_path, { snapshot: false, recordLine: [record.unit, record.brokerage].filter(Boolean).join(' · ') });
      return;
    }
    const snaps = snapshotsOf(record);
    if (!snaps.length) {
      fail(new Error('This listing has no screenshot in the bundle.'));
      return;
    }
    // Open on "Listed" when there is one — the moment Jason asked to see —
    // and otherwise on the first thing that happened.
    let current = Math.max(0, snaps.findIndex((s) => s.label === 'Listed'));
    const pick = async (i) => {
      current = i;
      for (const [j, b] of [...(picks?.children || [])].entries()) {
        b.setAttribute('aria-pressed', String(j === i));
      }
      await show(snaps[i].path, { snapshot: true, label: snaps[i].label, recordLine: record.unit || '' });
    };
    if (picks && snaps.length > 1) {
      snaps.forEach((s, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = s.label;
        b.addEventListener('click', () => pick(i));
        picks.appendChild(b);
      });
      picks.hidden = false;
    }
    await pick(current);
  }

  return { open, close: () => dialog.close() };
}
