# =============================================================================
# r/04_build_manifest.R
# Write web/public/data/manifest.json — lastUpdated, per-shard counts, total
# shard count. Read by the site footer ("Data as of …").
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

shard_files <- list.files(SERIES_DIR, pattern = "\\.json$", full.names = TRUE)
if (length(shard_files) == 0) {
  stop("[04] No shards found in ", SERIES_DIR, ". Run 03_build_data_files.R first.")
}

# Per-shard metadata: row count, year range.
shard_meta <- lapply(shard_files, function(f) {
  payload <- fromJSON(f, simplifyVector = TRUE, simplifyDataFrame = FALSE)
  records <- payload$records
  if (is.null(records)) {
    n     <- 0L
    y_lo  <- NA_integer_
    y_hi  <- NA_integer_
  } else if (is.data.frame(records)) {
    n     <- nrow(records)
    y_lo  <- suppressWarnings(min(records$year, na.rm = TRUE))
    y_hi  <- suppressWarnings(max(records$year, na.rm = TRUE))
  } else {
    n     <- length(records)
    years <- vapply(records, function(r) as.integer(r$year %||% NA), integer(1))
    y_lo  <- suppressWarnings(min(years, na.rm = TRUE))
    y_hi  <- suppressWarnings(max(years, na.rm = TRUE))
  }
  list(
    file        = basename(f),
    geoUid      = payload$geoUid,
    geoName     = payload$geoName,
    geoLevel    = payload$geoLevel,
    recordCount = as.integer(n),
    yearMin     = as.integer(y_lo),
    yearMax     = as.integer(y_hi)
  )
})

# Detect the most recent year across all shards as the "data as of" date.
all_years <- unlist(lapply(shard_meta, function(m) m$yearMax), use.names = FALSE)
all_years <- all_years[is.finite(all_years)]
data_max_year <- if (length(all_years)) max(all_years) else NA_integer_

manifest <- list(
  version       = 1,
  lastUpdated   = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  cmhcMaxYear   = data_max_year,
  shardCount    = length(shard_meta),
  totalRecords  = sum(vapply(shard_meta, function(m) m$recordCount, integer(1))),
  shards        = shard_meta
)

out_path <- file.path(WEB_DATA, "manifest.json")
writeLines(toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, na = "null"),
           out_path, useBytes = TRUE)

message(sprintf("[04] Wrote %s (%d shards; %d total records; latest year %s)",
                out_path,
                manifest$shardCount,
                manifest$totalRecords,
                ifelse(is.na(data_max_year), "NA", as.character(data_max_year))))
