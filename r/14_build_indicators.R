# =============================================================================
# r/14_build_indicators.R
# Read every *_indicators.csv (currently boc + statscan; cba once unblocked),
# join with the catalog metadata, and write web/public/data/indicators/
# shards plus indicators-manifest.json.
#
# Shard layout: one JSON per displayGroup (mortgage_market.json,
# credit_conditions.json, prices.json, supply.json, demand.json,
# construction_cost.json, derived.json). Each is a long-form record array.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

CATALOG_PATH <- file.path(ROOT, "r", "lib", "indicator_catalog.json")
catalog <- jsonlite::read_json(CATALOG_PATH, simplifyVector = FALSE)
INDICATORS_DIR <- file.path(WEB_DATA, "indicators")
dir.create(INDICATORS_DIR, recursive = TRUE, showWarnings = FALSE)

# Catalog as a lookup keyed by id. We attach the catalog metadata to every
# record so the frontend doesn't have to load the catalog separately.
cat_by_id <- setNames(catalog$series, vapply(catalog$series, function(s) s$id, character(1)))

# --- Read CSVs ---------------------------------------------------------------
read_safe <- function(path) {
  if (!file.exists(path)) {
    message(sprintf("[14] %s not found, skipping", path))
    return(tibble::tibble())
  }
  read_csv(path, show_col_types = FALSE)
}

boc <- read_safe(file.path(DATA_DIR, "boc_indicators.csv"))
stc <- read_safe(file.path(DATA_DIR, "statscan_indicators.csv"))
cba <- read_safe(file.path(DATA_DIR, "cba_arrears.csv"))   # not yet produced; harmless empty

all_obs <- bind_rows(boc, stc, cba)
if (nrow(all_obs) == 0) stop("[14] no indicator data found — run the scrape scripts first.")

# --- Attach catalog metadata + map to displayGroup --------------------------
all_obs <- all_obs %>%
  mutate(date = as.character(as.Date(date))) %>%
  rowwise() %>%
  mutate(
    displayGroup  = cat_by_id[[id]]$displayGroup %||% "other",
    expectedTitle = cat_by_id[[id]]$expectedTitle %||% id,
    sourceUrl     = cat_by_id[[id]]$sourceUrl     %||% "",
    provider      = cat_by_id[[id]]$provider      %||% NA_character_,
    seriesIdOut   = cat_by_id[[id]]$seriesId %||% cat_by_id[[id]]$vectorId %||% ""
  ) %>%
  ungroup()

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

# --- Per-group shards --------------------------------------------------------
clear_dir <- function(d) {
  if (dir.exists(d)) {
    f <- list.files(d, pattern = "\\.json$", full.names = TRUE)
    if (length(f)) file.remove(f)
  }
  dir.create(d, recursive = TRUE, showWarnings = FALSE)
}
clear_dir(INDICATORS_DIR)

groups <- unique(all_obs$displayGroup)
shard_meta <- list()
for (g in groups) {
  sub <- all_obs %>% filter(displayGroup == g) %>% arrange(id, date)
  # Series-level metadata block included once per series at the top.
  series_in_group <- unique(sub$id)
  meta <- lapply(series_in_group, function(sid) {
    s <- cat_by_id[[sid]]
    last <- sub %>% filter(id == sid) %>% slice_tail(n = 1)
    item <- list(
      id            = sid,
      provider      = s$provider,
      seriesId      = s$seriesId %||% s$vectorId,
      title         = s$expectedTitle,
      frequency     = s$frequency,
      units         = s$units,
      indexBase     = s$indexBase,
      geo           = s$geo,
      transform     = s$transform,
      displayGroup  = s$displayGroup,
      chartId       = s$chartId,
      chartLabel    = s$chartLabel,
      sourceUrl     = s$sourceUrl,
      latestDate    = if (nrow(last)) last$date  else NA,
      latestValue   = if (nrow(last)) last$value else NA
    )
    # Strip NULL and zero-length entries so jsonlite doesn't render them as `{}`.
    Filter(function(x) !is.null(x) && length(x) > 0, item)
  })
  payload <- list(
    group   = g,
    series  = meta,
    records = sub %>% transmute(id, date, value)
  )
  out <- file.path(INDICATORS_DIR, sprintf("%s.json", g))
  writeLines(jsonlite::toJSON(payload, auto_unbox = TRUE, na = "null", digits = 6),
             out, useBytes = TRUE)
  shard_meta[[g]] <- list(
    group       = g,
    file        = basename(out),
    seriesCount = length(meta),
    recordCount = nrow(sub),
    latestDate  = max(sub$date, na.rm = TRUE)
  )
  message(sprintf("[14] Wrote %s (%d series, %d records, latest %s)",
                  out, length(meta), nrow(sub), max(sub$date, na.rm = TRUE)))
}

# --- Indicators manifest -----------------------------------------------------
manifest <- list(
  version     = 1,
  generated   = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  groups      = unname(shard_meta),
  totalSeries = length(unique(all_obs$id)),
  totalRecords = nrow(all_obs)
)
imf_path <- file.path(WEB_DATA, "indicators-manifest.json")
writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, na = "null"),
           imf_path, useBytes = TRUE)
message(sprintf("[14] Wrote %s (%d groups, %d series, %d records)",
                imf_path, length(shard_meta), manifest$totalSeries, manifest$totalRecords))

# --- Copy the catalog into the public data tree so the frontend can read --
# the charts / displayGroups / snapshotPick metadata without a separate API.
catalog_out <- file.path(INDICATORS_DIR, "_catalog.json")
file.copy(CATALOG_PATH, catalog_out, overwrite = TRUE)
message(sprintf("[14] Copied catalog to %s", catalog_out))
