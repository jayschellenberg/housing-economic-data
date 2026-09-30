import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Build identity for the Rental and Commercial sub-apps' About panels (they
// cite the build that produced an export). Vercel provides the SHA; locally
// we ask git; either may be absent.
function resolveCommit() {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [tailwindcss()],
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  define: {
    __APP_COMMIT__: JSON.stringify(resolveCommit()),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Pre-bundle the heavy shared deps at server start so adding a new importer
  // (e.g. map.js also importing plot + html-to-image) can't trigger a mid-load
  // re-optimization, which otherwise 504s the in-flight dep requests and leaves
  // the page half-initialised ("Outdated Optimize Dep").
  optimizeDeps: {
    include: ['@observablehq/plot', 'html-to-image', 'd3'],
    // MapLibre 6 loads its tile worker as a sibling module
    // (maplibre-gl-worker.mjs). Vite's pre-bundler rewrites the entry but
    // does not emit the worker, so in dev the worker 404s and the map hangs
    // with a grey canvas. Serving the package unbundled keeps it resolvable
    // (the production build emits the worker as an asset either way).
    exclude: ['maplibre-gl'],
  },
  build: {
    // The two sub-apps were written for es2022; the main site's own code is
    // es2020-clean, so the higher target costs nothing there.
    target: 'es2022',
    // MapLibre is ~900 kB minified and cannot usefully be split further.
    chunkSizeWarningLimit: 950,
    rollupOptions: {
      // Three same-origin pages: the site itself, and the Rental and
      // Commercial explorers shown inside their Local Data tabs (iframes).
      // Same origin is what lets the folder picker and IndexedDB work inside
      // the frame.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        rental: fileURLToPath(new URL('./rental/index.html', import.meta.url)),
        commercial: fileURLToPath(new URL('./commercial/index.html', import.meta.url)),
      },
      output: {
        manualChunks(id) {
          const p = id.replace(/\\/g, '/');
          if (!p.includes('node_modules')) return undefined;
          // The sub-apps' map stack, loaded only by their pages.
          if (p.includes('maplibre-gl')) return 'maplibre';
          if (p.includes('pmtiles') || p.includes('@protomaps')) return 'pmtiles';
          // Split heavy libs into their own lazy-loadable chunks so the
          // eager vendor bundle stays small. ExcelJS in particular is only
          // referenced via dynamic import() from the three Download buttons,
          // so it should only land on the wire when the user clicks one.
          if (p.includes('exceljs') || p.includes('archiver') || p.includes('saxes') || p.includes('xmlbuilder')) return 'exceljs';
          // docx (Word export) is likewise only reached via dynamic import().
          if (p.includes('node_modules/docx/') || p.includes('xml-js') || p.includes('node_modules/xml/') || p.includes('hash.js') || p.includes('nanoid')) return 'docx';
          // jszip is shared by exceljs and docx — its own chunk keeps it out
          // of the eager vendor bundle without binding it to either consumer.
          if (p.includes('jszip')) return 'jszip';
          if (p.includes('html-to-image')) return 'html-to-image';
          // Plot + d3 are left in `vendor` (not their own chunk): they load
          // eagerly anyway (charts is the default tab), and they share transitive
          // deps with vendor, so any split produced a benign but noisy circular
          // chunk warning. Keeping them together removes the cycle.
          return 'vendor';
        },
      },
    },
  },
});
