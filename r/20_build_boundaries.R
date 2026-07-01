#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# 20_build_boundaries.R — geographic boundary build step for the map views.
#
# Produces small, simplified GeoJSON boundary files (WGS84) that the web app's
# Observable Plot choropleths draw from. Self-hosted under web/public/data/geo/
# so nothing leaves the same origin (the strict CSP stays intact) and the
# existing PNG/Word export keeps working.
#
# Source: Statistics Canada 2021 Census *cartographic* boundary files (the
# coastline-clipped, map-ready variants), Open Government Licence – Canada.
# Feature ids are the real StatCan codes (CSDUID / CDUID / PRUID), which join
# DIRECTLY to the app's census-family GeoUIDs (e.g. 4611040 = Winnipeg CSD,
# 4602 = Winnipeg CD, 46 = Manitoba).
#
# Pipeline: sf reads / filters to province / reprojects to WGS84 / keeps id+name
# (reliable, no shell quoting), then mapshaper does the topology-preserving
# simplify (shared borders stay gap-free — st_simplify would leave slivers).
# mapshaper is a dev dependency (web/node_modules/.bin); if it is missing or
# fails, we fall back to sf::st_simplify so the build still produces output.
# NB: rmapshaper is NOT used — its bundled V8 engine segfaults in this env.
#
# Scope: MB/SK/AB/BC (the provinces in the app's data) at CD + CSD level. Writes
# one file per province+level — <slug>_<level>.geojson (mb_csd, sk_csd, ab_csd,
# bc_csd, and the _cd counterparts) — so each map lazy-loads only its province.
# To extend: add province codes to PROVINCES and slugs to SLUG, re-run.
#
# Run:  Rscript r/20_build_boundaries.R      (or: npm run data:geo, from web/)
# ---------------------------------------------------------------------------

suppressMessages(library(sf))

# --- Paths -----------------------------------------------------------------
this_dir <- tryCatch(dirname(sub("^--file=", "",
             grep("^--file=", commandArgs(FALSE), value = TRUE)[1])), error = function(e) ".")
if (is.na(this_dir) || !nzchar(this_dir)) this_dir <- "r"
repo_root <- normalizePath(file.path(this_dir, ".."), mustWork = FALSE)
cache_dir <- file.path(repo_root, "r", "lib", "cache", "geo")
out_dir   <- file.path(repo_root, "web", "public", "data", "geo")
dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)
dir.create(out_dir,   recursive = TRUE, showWarnings = FALSE)

# --- Config ----------------------------------------------------------------
PROVINCES <- c("46", "47", "48", "59")     # MB, SK, AB, BC — the provinces in the data
SLUG      <- c("46" = "mb", "47" = "sk", "48" = "ab", "59" = "bc")
BASE_URL  <- "https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers"
PRECISION <- 0.0001                        # mapshaper coordinate precision (~11 m)

LEVELS <- list(
  cd  = list(zip = "lcd_000b21a_e.zip", id = "CDUID",  name = "CDNAME",  simplify = "1.5%"),
  csd = list(zip = "lcsd000b21a_e.zip", id = "CSDUID", name = "CSDNAME", simplify = "1%")
)
# BC's fjorded coastline has huge vertex counts, so it needs a much harder simplify
# than the prairie provinces to keep the files a reasonable size (keeps all features).
SIMPLIFY_OVERRIDE <- list("59" = c(cd = "0.2%", csd = "0.2%"))

# --- mapshaper (topology-preserving simplify) ------------------------------
ms_bin <- (function() {
  ext   <- if (.Platform$OS.type == "windows") ".cmd" else ""
  local <- file.path(repo_root, "web", "node_modules", ".bin", paste0("mapshaper", ext))
  if (file.exists(local)) local else NA_character_
})()

mapshaper_simplify <- function(in_geojson, out_geojson, pct) {
  if (is.na(ms_bin)) return(FALSE)
  if (file.exists(out_geojson)) unlink(out_geojson)
  # Input is already MB-only WGS84 with just id+name, so the args are simple
  # flags — no JS expressions to quote through the shell. `rfc7946` enforces the
  # right-hand-rule winding (CCW exterior rings) so the output is correct for any
  # spherical GeoJSON consumer (d3-geo etc.); the app's own renderer is
  # winding-agnostic but this keeps the files standard-compliant.
  args <- c(in_geojson, "-simplify", pct, "keep-shapes",
            "-o", paste0("precision=", PRECISION), "rfc7946", out_geojson, "force")
  ok <- tryCatch(system2(ms_bin, args, stdout = FALSE, stderr = FALSE) == 0,
                 error = function(e) FALSE)
  ok && file.exists(out_geojson)
}

write_geojson <- function(g, dest) {
  if (file.exists(dest)) unlink(dest)
  sf::st_write(g, dest, driver = "GeoJSON", quiet = TRUE,
               layer_options = "COORDINATE_PRECISION=5")
}

# --- Helpers ---------------------------------------------------------------
download_if_needed <- function(zipname) {
  dest <- file.path(cache_dir, zipname)
  if (file.exists(dest) && file.info(dest)$size > 1e5) {
    message(sprintf("  cached: %s (%.1f MB)", zipname, file.info(dest)$size / 1e6)); return(dest)
  }
  message(sprintf("  downloading: %s", file.path(BASE_URL, zipname)))
  old <- getOption("timeout"); options(timeout = 600); on.exit(options(timeout = old), add = TRUE)
  utils::download.file(file.path(BASE_URL, zipname), dest, mode = "wb", quiet = TRUE)
  dest
}

read_shp <- function(zippath) {
  exdir <- file.path(cache_dir, sub("\\.zip$", "", basename(zippath)))
  if (!dir.exists(exdir) || !length(list.files(exdir, pattern = "\\.shp$")))
    utils::unzip(zippath, exdir = exdir)
  sf::st_read(list.files(exdir, pattern = "\\.shp$", full.names = TRUE)[1], quiet = TRUE)
}

# --- Build -----------------------------------------------------------------
message("Building boundary files for provinces: ", paste(PROVINCES, collapse = ", "),
        if (is.na(ms_bin)) "  [mapshaper NOT found — using st_simplify fallback]" else "  [mapshaper]")
for (lv in names(LEVELS)) {
  cfg <- LEVELS[[lv]]
  message(sprintf("[%s]", toupper(lv)))
  g_all <- read_shp(download_if_needed(cfg$zip))       # national — read once per level
  if (!"PRUID" %in% names(g_all)) stop("PRUID column not found in ", cfg$zip)

  for (prov in PROVINCES) {
    g <- g_all[as.character(g_all$PRUID) == prov, , drop = FALSE]
    if (!nrow(g)) { message(sprintf("  %s: no features — skipped", prov)); next }

    g <- sf::st_transform(g, 4326)                     # transform only the province subset
    g <- sf::st_sf(id = as.character(g[[cfg$id]]), name = as.character(g[[cfg$name]]),
                   geometry = sf::st_geometry(g))
    g <- g[order(g$id), , drop = FALSE]

    dest <- file.path(out_dir, sprintf("%s_%s.geojson", SLUG[[prov]], lv))
    tmp  <- file.path(tempdir(), sprintf("%s_%s_full.geojson", SLUG[[prov]], lv))
    write_geojson(g, tmp)

    pct <- if (!is.null(SIMPLIFY_OVERRIDE[[prov]])) SIMPLIFY_OVERRIDE[[prov]][[lv]] else cfg$simplify
    if (mapshaper_simplify(tmp, dest, pct)) {
      how <- "mapshaper"
    } else {                                            # fallback: st_simplify in a metric CRS
      gp <- sf::st_transform(g, 3347)
      gp <- sf::st_simplify(gp, dTolerance = 200, preserveTopology = TRUE)
      write_geojson(sf::st_transform(gp, 4326), dest)
      how <- "st_simplify(fallback)"
    }
    message(sprintf("  wrote %s — %d features, %.0f KB [%s]",
                    basename(dest), nrow(g), file.info(dest)$size / 1024, how))
  }
}
message("Done. Boundary files in web/public/data/geo/")
