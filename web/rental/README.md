# Manitoba Rental Explorer (web/)

Static Vite site for the firm's scraped rental data, modelled on the
Sales Analysis tab of the Manitoba Parcel Search. **Ships no data**: a
user connects the published `RentalDashboard\` folder (Dropbox, RRG
Shared → Apps) once through the File System Access API; its `export\`
subfolder is read into IndexedDB, after each weekly publish a Reload
imports the changed files, and its `evidence\` subfolder is walked on
demand to open archived listing pages. Connecting `export\` alone still
works, minus the archived pages (a handle cannot see its parent). The producer is `scripts/export_web.py`;
`src/lib/bundle.js` is the consumer-side contract (column names, schema
major).

```powershell
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # eslint + node tests (the live-bundle test self-skips without the folder)
npm run build      # dist/
```

Deploy: Vercel project with **Root Directory = `web`** (`vercel.json`
here carries the CSP + noindex headers). The build runs the tests first.

| Path | Purpose |
|---|---|
| `src/lib/bundle.js` | schema contract + parsers (pure; node-testable) |
| `src/lib/store.js` | IndexedDB + directory handle + import / update check |
| `src/lib/delimitedRows.js` | quote-aware CSV tokenizer (from the parcel search) |
| `src/lib/filters.js` | filter state shape, predicate, time-window resolution, hidden-filter chips (pure) |
| `src/lib/results.js` | column catalogue, sort, paging, policy-aware medians, CSV serializer (pure) |
| `src/lib/multiSelect.js` | compact searchable checkbox picker with counts, Select all (visible rows) / Clear |
| `src/lib/munis.js` | municipality index (regions + adjacency), effective-selection and grouping helpers (pure) |
| `src/lib/shapeFilter.js` | drawn-area predicates: point-in-ring, include/exclude semantics, rings (pure; from the parcel search) |
| `src/muniPicker.js` | region-grouped municipality picker with the Adjacent-regions pill; also driven by map clicks |
| `src/drawShapes.js` | radius / rectangle / polygon drawing on the map, include ⇄ exclude toggle, clear |
| `public/data/muni-index.json` | muni_no, name, list_name, region, adjacent[] — built from the mao-scrape `muni_regions.csv` (`config.MUNI_REGIONS_CSV`), the same groupings the Parcel Search's Sales Analysis uses |
| `src/connectPanel.js` | the "Rental data" sidebar panel |
| `src/filtersPanel.js` | filter controls ⇄ state, persisted in localStorage |
| `src/resultsTable.js` | sortable, paged results grid + row selection + count line + export toolbar |
| `src/lib/exports.js` | criteria text, Word HTML/TSV, typed XLSX rows (pure) |
| `src/exports.js` | clipboard, downloads, exceljs workbook (lazy-loaded), map PNG |
| `src/lib/evidencePath.js` | folder-layout detection + evidence path validation (pure) |
| `src/evidence.js` | archived-page viewer: sandboxed iframe, open-in-tab, download |
| `src/mapView.js` | MapLibre map: Protomaps basemap, listing points by bedroom band, boundary overlays, subject + radius |
| `src/lib/analysis.js` | band / market statistics, period trends from the rent runs, histogram, size points, other stats (pure) |
| `src/lib/bands.js` | bedroom-band colours + labels shared by map, legend and charts |
| `src/analysis.js` | the Analysis tab: KPI tiles, tables (copy for Word), Observable Plot charts (lazy chunk) |
| `src/main.js` | entry; connect → filter → table + map + analysis; workspace tabs |
| `public/data/*.geojson` | simplified boundary overlays, built by `../scripts/build_web_overlays.py` from the base files |
| `public/basemap-sprites/` | Protomaps "light" sprites (copied from the parcel search) |
| `test/` | `node --test` files run by `test/run.js` |

**Basemap.** The same self-hosted Protomaps archive the parcel search and
the R dashboards use (`basemap-manitoba.pmtiles` on the mb-ortho R2
bucket, maintained by the parcel-search project — do not fork it).
Glyphs come from demotiles.maplibre.org; both hosts are in the CSP
`connect-src`. Override the archive for local work with
`VITE_BASEMAP_PMTILES_URL` in `web/.env.local`.

**MapLibre version.** 6.9.1 (upgraded from 4.7.1 on 2026-09-15). Two
things the upgrade needed: the package has no default export (use
`import * as maplibregl`), and its tile worker is a sibling module file
that imports a shared chunk. Two pieces make it work: `optimizeDeps.exclude:
['maplibre-gl']` in `vite.config.js` (dev pre-bundling otherwise loses the
file) and, in `mapView.js`, `import workerUrl from
'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'` +
`maplibregl.setWorkerUrl(workerUrl)` — Vite then bundles the worker with
its shared chunk into one hashed asset. A plain `?url` import ships a
19 KB worker whose relative import 404s on Vercel and the map stays
blank with no error. The Playwright checks read
GeoJSON sources through `getSource(id).serialize().data`, not the
private `_data`.

**Verifying the map.** MapLibre loads its style on an animation frame,
which never fires in a hidden browser pane — the canvas stays grey with
no error. Headless Chromium via Playwright renders fine; see the
`scripts/screenshot_listing.py` launch flags for a working setup.

Dev convenience: when the live export folder exists on this machine, the
dev server also serves it under `/@fs/<path>/…` (see `vite.config.js`),
so the real bundle can be loaded into the page from the console without
the folder picker. Production serves nothing of the kind.

**Exports.** Scope = the filtered set or the ticked rows (selection
survives filter changes, so a comp set can be picked across searches).
CSV carries every field; Excel adds a Criteria sheet and number
formats; Copy for Word puts an inline-styled table on the clipboard with
the criteria above it (TSV twin for Excel / plain text); Map PNG writes
the current view with legend and attribution.

**Municipalities.** The picker groups municipalities by the six Manitoba
regions the Parcel Search uses, labelled name-first ("ALTONA (TOWN)").
Select all ticks whatever the search shows; the Adjacent-regions pill
adds every municipality sharing a boundary with a pick (one hop; untick
a neighbour to waive it). On the map, picks tint dark blue and adjacent
ones light blue. The top-bar "Click map to select" switch (Off / Munis /
MLS areas) makes a map click toggle that area in its picker — the area
wins over cluster bubbles and popups while a mode is on; selected MLS
areas tint orange. Neighbours with no listings in the bundle are not
offered. "Reset search" (workspace) and "Reset" (Filters panel) return
every control, the subject, drawn shapes and picks to their defaults.
Hovering a listing shows its details; clicking adds the source link.

**Drawn areas.** ◯ ▭ ⬠ in the map toolbar draw a radius, rectangle or
polygon (Matrix-MLS conventions: click centre then radius; corner then
corner; vertices then double-click or first vertex). A shape starts as
Include; clicking its centre dot or fill flips it to Exclude. Exclude
always wins; with any Include shape a listing must fall inside one;
unmapped listings drop once a shape exists. Shapes live in the filter
state (chip in the badge, cleared by Clear, restored on reload).

**Analysis tab.** Scope = the current selection or all Manitoba (the
default view: active, one row per unit), each read against the other.
Per-bedroom KPI tiles; a rent-by-bedroom table (n, median, mean,
quartiles, $/sf); a by-market table (municipality / MLS area / Winnipeg
neighbourhood / listed city, largest 40, catch-all bucket last); trend
lines by bedroom count — median rent, median $/sf, listings observed —
by month or ISO week, from `rent_segments.csv` (a listing counts in a
period it was observed in, at the rent it showed then; the latest
period is partial); a $100-bin rent histogram; rent vs size with a
least-squares line per band; days observed, rent-change share and
median change, amenity shares, and the source mix. Medians and means
follow the policy (display band, min-n); $/sf ignores sizes under 100
or over 10,000 sf. Tables copy for Word with the criteria above them.
Charts are Observable Plot, bundled and loaded on first open.

**Clustering.** Listings merge into count bubbles up to zoom 12 (like
the admin dashboard's marker clusters); click a bubble to zoom in. The
Cluster checkbox turns it off and is remembered.

**Grid follows map view** (opt-in, remembered). While on, the grid, the
count line and the Analysis "selection" narrow to whatever the map
currently shows, re-applied a quarter-second after each pan or zoom; the
map itself keeps plotting the whole filtered set, auto-zoom to results
is paused so the two cannot chase each other, the count line says
"(map view · N in the full selection)", and exports add a "Within the
map view" line with the bounds to their criteria. The viewport is not
part of the filter state: Reset and reload do not carry it.

**Archived pages.** The 📄 button on a row reads that listing's published
evidence HTML through the saved directory handle and shows it in a
`<dialog>` inside an `<iframe sandbox>` with no flags, so nothing in the
page can run (the file also carries a `script-src 'none'` meta from
publish). Open-in-tab hands the same bytes to a blob URL; Download saves
the file. Testing tip: the Origin Private File System root is a real
`FileSystemDirectoryHandle`, so a headless test can build
`export/` + `evidence/` in it and store it as the saved handle.

Phases: 1 export ✔ · 2 scaffold + connect ✔ · 3 filters + table + CSV ✔ ·
4 map + subject radius ✔ · 5 analysis tab ✔ · 6 exports ✔ ·
7 archived pages ✔ · 8 Quarto viewer retired ✔ (all 2026-09-14).

Live: https://mb-rental-explorer.vercel.app (Vercel project
`mb-rental-explorer`, team jks-consulting-inc, Root Directory `web`,
deploys on push to `main`; the build runs `npm test` first).
