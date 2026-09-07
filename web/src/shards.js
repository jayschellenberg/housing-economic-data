// Where the per-geography shards come from.
//
// The CMHC Rms (`series/`) and Scss (`starts/`) shards are ~401 MB across 1,340
// files. They used to sit in web/public/data/, which meant Vite copied all of
// them into dist/ and Vercel stored the lot on every deployment — no
// de-duplication between deployments, so ~425 MB per deploy to change one
// shard. They now live in the housing-economic-shards repo and are fetched
// through the same-origin /gh-data proxy (api/gh-data.js), which puts Vercel's
// edge cache in front of raw.githubusercontent.
//
// Everything else under web/public/data/ (indicators, housing, economy, geo,
// the manifests) stays in the app: it is ~24 MB in total and several parts of
// it are read before the first paint, so the extra hop would not pay for
// itself.

/**
 * Commit SHA in housing-economic-shards that production reads.
 *
 * THIS IS THE PUBLISH SWITCH. Pushing new shards changes nothing on its own;
 * production keeps serving the old pin until this constant moves, which is
 * deliberate — the app is never exposed to a half-pushed tree, and a bad
 * refresh is reverted by putting the previous SHA back rather than by
 * re-uploading data.
 *
 * The SHA also makes every shard URL immutable, which is what lets the proxy
 * cache them for a year. Changing the pin changes every URL, so no cache
 * anywhere needs purging.
 *
 * To repin: push the shards, then set this to the new commit SHA.
 */
export const SHARDS_REVISION = '3f95bcb7d54f55d212ec38dea30006bebceb05e8';

const SHARDS_BASE = `/gh-data/housing-economic-shards/${SHARDS_REVISION}`;

/**
 * URL for one shard.
 *
 * @param {'series'|'starts'} tree which shard family
 * @param {string} key `{level}_{uid}`, e.g. `cma_602`
 */
export function shardUrl(tree, key) {
  return `${SHARDS_BASE}/data/${tree}/${key}.json`;
}
