# Commercial Availability Explorer (web/)

A static site that reads the tracker's published bundle out of a shared
Dropbox folder and does everything else in the browser. **It ships no
data.** The deploy is an empty shell; the folder is the access control.

Live: https://housing-economic-data.vercel.app/#commercial

```
pipeline (v3, Sun 12pm + Wed 5pm)        shared Dropbox folder              browser (this site, on Vercel)
──────────────────────────────           ─────────────────────────          ──────────────────────────────
… rebuild_all … publish gate             CommercialAvailability\          connect the folder once
  publish_to_dropbox.py    ─────────►    ├── current_master.xlsx            ├─ store.js    IndexedDB + handle
    stable handles + linked flyers       ├── current_listings.csv           ├─ bundle.js   schema contract
  export_web.py                          ├── qa_latest.txt                  ├─ filters → results → grid/CSV
    records.csv                          ├── export\                        ├─ mapView.js  MapLibre + Protomaps
    history_runs.csv                     │   ├── records.csv                ├─ analysis.js Observable Plot
    manifest.json                        │   ├── history_runs.csv           ├─ exports.js  XLSX / Word / PNG
                                         │   └── manifest.json              └─ flyerViewer.js  PDF via the handle
                                         └── flyers\{Brokerage}\*.pdf
```

## Running it here

```bash
cd web && npm install
npm run dev            # vite; set PORT=xxxx, 5173 is usually taken
npm test               # eslint + node --test over test/*.test.js
npm run build
```

The dev server exposes the live published folder under `/@fs/…` (see
`vite.config.js`), which is how the verification scripts load the real
bundle without the folder picker. Override the location with
`COMMAVAIL_PUBLISHED_DIR`.

## Verifying

`npm test` covers the pure modules. Everything that needs a real browser
has a Playwright script, each runnable on its own and each starting its
own dev server:

| Script | What it proves |
|---|---|
| `test/verify_phase2.py` | connect, import into IndexedDB, summarize, reload; and that the **un-connected page names no source and no licensed column** |
| `test/verify_phase3.py` | filters drive the grid, sorting, paging, search, CSV matches the filter |
| `test/verify_phase4.py` | the basemap really loads, overlays, clustering, drawn shapes, click-to-select. **Run it with `--built` too** — see below |
| `test/verify_phase5.py` | Plot loads only on demand; all four charts render; granularity and grouping work |
| `test/verify_phase6.py` | a real .xlsx with both sheets, an HTML table on the clipboard, a non-blank map PNG |
| `test/verify_phase7.py` | a flyer read back through the directory handle, and the refusals |

```bash
cd web && python test/verify_phase4.py
```

**The dev server is not the deployed site.** MapLibre loads its tile
worker from a sibling module: the dev server resolves it out of
node_modules, and the built site has to emit it as an asset. When it did
not, `maplibre-gl-worker.mjs` 404'd on Vercel, the map stayed blank with
a clean console, and the dev-only check passed all the way through the
deploy. `mapView.js` imports the worker `?worker&url` and calls
`setWorkerUrl`; `verify_phase4.py --built` builds with `VITE_VERIFY=1`,
serves `vite preview`, and asserts the style loads and no request 404s.
Removing `setWorkerUrl` makes that check fail — worth re-proving if
anyone touches it.

```bash
cd web && python test/verify_phase4.py --built
```

Two more things make these work, both learned the hard way:

- **The in-app browser pane runs hidden**, so `requestAnimationFrame`
  never fires and MapLibre never finishes loading its style — a grey
  canvas with no error. Map checks use headless Chromium with
  `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`.
- **`VITE_VERIFY=1` is the only way in to a built bundle.** `window.__app`
  is dev-only in a real deploy; that flag also builds it into a production
  bundle so `--built` can drive the same paths. Vercel never sets it.
- **A real directory handle for tests**: `navigator.storage.getDirectory()`
  (the OPFS root) is a genuine `FileSystemDirectoryHandle`. Phase 7 builds
  `export/` + `flyers/` inside it and stores it as the saved handle, which
  exercises layout detection, permission, the directory walk and the blob
  URL against the same code a Dropbox folder goes through.

## The contract

`v3/export_web.py`'s `RECORD_COLUMNS` and `src/lib/bundle.js` are two
halves of one contract. **A schema change edits both in the same commit**,
and bumps `SCHEMA_VERSION` / `SCHEMA_MAJOR` when a column is renamed or
re-meaning'd — the site refuses a bundle whose major it does not know
rather than mis-reading it.

Policy constants (plausibility bands, `min_n`) ship in
`manifest.policy`, so the grid, the overview and the analysis tab all
suppress the same things for the same reason. Nothing in this repo
invents a cutoff of its own.

## Licensed columns

The bundle carries the Moody's and Lightbox/N1 derived columns, because
the folder reaches a controlled group. The rule the code enforces:
**nothing in the deployed page may name them, or any brokerage, before a
folder is connected.** Which columns are restricted comes from
`manifest.restricted_columns`, and the notice from
`manifest.restricted_notice` — both rendered only after a bundle loads.
`verify_phase2.py` asserts the shipped HTML is clean.

## Deploying

Vercel project `commercial-availability-explorer` on the
`jks-consulting-inc` team, connected to
`jayschellenberg/Commercial-Availability` with **Root Directory = `web`**
(set 2026-09-14 — without it a Git build runs `npm ci` at the repo root
and fails). The build command is `npm ci && npm test && npm run build`,
so the web tests gate every deploy: a broken module cannot go live.

**A push to `master` deploys.** To deploy by hand instead — a local
check, or when a push should not go out:

```bash
cd web && npx vercel deploy --prod
```

## Browser support

Chrome and Edge get the full thing: the folder is remembered between
visits, a changed mtime after the next publish offers a Reload, and
flyers open. Firefox and Safari have no directory picker, so they fall
back to a folder `<input>` — the data loads, but nothing is remembered
and flyers are out of reach.
