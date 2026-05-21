# =============================================================================
# r/00_build_capabilities.R
# Probe the cmhc package's table/filter introspection helpers and write a
# capabilities.json that the frontend uses to disable invalid combinations.
#
# Falls back to the hand-curated RMS_DIMENSIONS_BY_SERIES map in
# r/lib/cmhc_helpers.R if the introspection helpers aren't available in the
# installed cmhc version.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

output_path <- file.path(WEB_DATA, "capabilities.json")

# Try the live introspection path first.
live_capabilities <- function() {
  fns <- ls(getNamespace("cmhc"))
  has_tables  <- any(grepl("list_cmhc_tables",  fns)) || "list_cmhc_tables"  %in% fns
  has_filters <- any(grepl("list_cmhc_filters", fns)) || "list_cmhc_filters" %in% fns
  if (!has_tables) return(NULL)

  tables <- tryCatch(cmhc::list_cmhc_tables(), error = function(e) NULL)
  if (is.null(tables) || !is.data.frame(tables) || nrow(tables) == 0) return(NULL)

  # Filter to Primary Rental Market Survey rows only (column name varies).
  survey_col <- intersect(names(tables), c("survey", "Survey", "survey_code"))
  if (!length(survey_col)) return(NULL)
  rms <- tables[as.character(tables[[survey_col[1]]]) %in%
                  c("Rms", "RMS", "Primary Rental Market Survey"), , drop = FALSE]
  if (nrow(rms) == 0) return(NULL)

  series_col    <- intersect(names(rms), c("series",    "Series"))
  dimension_col <- intersect(names(rms), c("dimension", "Dimension"))
  if (!length(series_col) || !length(dimension_col)) return(NULL)

  series_dims <- split(
    as.character(rms[[dimension_col[1]]]),
    as.character(rms[[series_col[1]]])
  )
  series_dims <- lapply(series_dims, function(d) unique(d[!is.na(d) & d != ""]))

  # Restrict to the series we surface in the UI.
  series_dims <- series_dims[names(series_dims) %in% RMS_SERIES]
  if (length(series_dims) == 0) return(NULL)

  series_dims
}

curated_capabilities <- function() {
  Filter(Negate(is.null),
         lapply(RMS_SERIES, function(s) RMS_DIMENSIONS_BY_SERIES[[s]])) |>
    setNames(RMS_SERIES)
}

caps <- tryCatch(live_capabilities(), error = function(e) NULL)
source_label <- "live"
if (is.null(caps)) {
  message("[capabilities] cmhc::list_cmhc_tables() not usable; falling back to curated catalog.")
  caps <- curated_capabilities()
  source_label <- "curated"
}

# Build the JSON shape the frontend reads.
series_json <- lapply(names(caps), function(series) {
  list(
    dimensions    = as.list(caps[[series]]),
    dwellingTypes = as.list(DWELLING_TYPES)
  )
})
names(series_json) <- names(caps)

payload <- list(
  version    = 1,
  source     = source_label,
  generated  = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  geoLevels  = list("province", "cma", "csd", "zone", "neighbourhood"),
  series     = series_json
)

writeLines(toJSON(payload, auto_unbox = TRUE, pretty = TRUE), output_path, useBytes = TRUE)
message(sprintf("[capabilities] Wrote %s (source = %s)", output_path, source_label))
