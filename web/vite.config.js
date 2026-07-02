import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  // Pre-bundle the heavy shared deps at server start so adding a new importer
  // (e.g. map.js also importing plot + html-to-image) can't trigger a mid-load
  // re-optimization, which otherwise 504s the in-flight dep requests and leaves
  // the page half-initialised ("Outdated Optimize Dep").
  optimizeDeps: {
    include: ['@observablehq/plot', 'html-to-image', 'd3'],
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          const p = id.replace(/\\/g, '/');
          if (!p.includes('node_modules')) return undefined;
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
