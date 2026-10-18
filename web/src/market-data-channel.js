/*
 * market-data-channel.js — the one-line notice market-data.js sends when it
 * has filled a tab's store from the shared AppMarketData folder, so a tab that
 * is already open (or a dashboard in its iframe) can reload what it shows.
 *
 * Kept apart from market-data.js so the dashboards can listen without pulling
 * in every tab's store. A BroadcastChannel reaches every same-origin page and
 * frame, including other channel objects in the sending page itself.
 */

const CHANNEL = 'hed-market-data';

/** Tell listeners which sources ('zoning', 'rental', ...) changed. */
export function announceSources(ids) {
  if (!ids?.length || typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage({ type: 'sources-updated', ids: [...ids] });
  ch.close();
}

/**
 * Run `fn` whenever any of `ids` is announced. Returns an unsubscribe.
 * @param {string[]} ids
 * @param {(ids: string[]) => void} fn
 */
export function onSourcesUpdated(ids, fn) {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => {
    const got = e.data?.type === 'sources-updated' ? e.data.ids || [] : [];
    const hit = got.filter((id) => ids.includes(id));
    if (hit.length) {
      Promise.resolve().then(() => fn(hit)).catch((err) => console.error('[market-data listener]', err));
    }
  };
  return () => ch.close();
}
