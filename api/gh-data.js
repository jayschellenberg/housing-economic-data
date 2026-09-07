// Vercel Edge Function — same-origin proxy for the shard data repo
// (housing-economic-shards), upstreaming to raw.githubusercontent.com.
//
// Why the shards live in another repo at all: Vercel stores the full build
// output of every retained deployment separately, with no de-duplication
// between deployments (measured 2026-09-07: 36.14 GB across the team against a
// 10 GB tier). The 401 MB of series/ + starts/ shards were committed here and
// copied into dist/ on every build, so each deployment cost ~425 MB while a
// typical commit changed one or two shards. They now live in the data repo and
// the app's build output is ~25 MB.
//
// Why a proxy rather than fetching raw.githubusercontent directly:
// raw.githubusercontent serves per-file with no repo-size limit, but it
// rate-limits per client IP. An office behind one NAT flipping through
// geographies fires a shard fetch each time, and the loaders treat a failed
// fetch as "no data for this geography" — a 429 would show up as a blank chart
// rather than an error. Routing through this function puts Vercel's edge cache
// between users and GitHub: every URL embeds an immutable commit SHA, so each
// file is fetched from GitHub roughly once per edge region per pin and served
// from cache after that. GitHub only ever sees Vercel egress.
//
// This mirrors api/gh-data.js in manitoba-opendata-parcelsearch; keep the two
// in step if either is fixed.
//
// Path contract (see the vercel.json rewrite):
//   /gh-data/<repo>/<sha>/<path...>
// The rewrite also passes the original path as ?p= so the function works
// whether the platform hands it the original or the rewritten URL.
//
// Failures are returned with `no-store` so a transient upstream 429 or 5xx
// cannot get pinned into the edge cache for a year.

export const config = {
  runtime: 'edge',
};

const OWNER = 'jayschellenberg';
const REPOS = new Set(['housing-economic-shards']);

const PATH_RE = /^\/?gh-data\/([^/]+)\/([0-9a-f]{7,40})\/(.+)$/;

const CONTENT_TYPES = {
  json: 'application/json',
  geojson: 'application/geo+json',
  csv: 'text/csv',
};

export default async function handler(request) {
  const url = new URL(request.url);
  // Prefer the ?p= the rewrite injects; fall back to the pathname for direct
  // hits on /gh-data/... (platform rewrite semantics differ on whether a
  // function sees the original or the destination URL).
  const raw = url.searchParams.get('p') || url.pathname;
  const m = PATH_RE.exec(raw.startsWith('/') ? raw : `/${raw}`);
  if (!m || !REPOS.has(m[1]) || m[3].includes('..')) {
    return fail(400, `Bad gh-data path: ${raw}`);
  }
  const [, repo, sha, path] = m;

  let upstream;
  try {
    upstream = await fetch(
      `https://raw.githubusercontent.com/${OWNER}/${repo}/${sha}/${path}`,
    );
  } catch (err) {
    return fail(502, `Upstream fetch failed: ${err.message}`);
  }
  if (!upstream.ok || !upstream.body) {
    return fail(upstream.status || 502,
      `Upstream returned ${upstream.status} ${upstream.statusText}`);
  }

  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      // The SHA in the URL makes the content immutable: cache hard, both at the
      // edge (s-maxage) and in the browser. A repin changes every URL, so
      // nothing ever needs purging.
      'Cache-Control': 'public, max-age=86400, s-maxage=31536000, immutable',
    },
  });
}

function fail(status, message) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
