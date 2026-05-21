# =============================================================================
# r/03_build_data_files.R
# Read the three working CSVs (historical, zone, neighbourhood) and write:
#   - web/public/data/series/{level}_{uid}.json  one long-form shard per geo
#   - web/public/data/geographies.json           dropdown index by level
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

hist_path <- file.path(DATA_DIR, "historical_rental.csv")
zone_path <- file.path(DATA_DIR, "zone_snapshots.csv")
nbhd_path <- file.path(DATA_DIR, "neighbourhood_snapshots.csv")

read_or_empty <- function(p) {
  if (!file.exists(p)) return(tibble::tibble())
  tryCatch(read_csv(p, show_col_types = FALSE), error = function(e) tibble::tibble())
}

hist <- read_or_empty(hist_path)
zone <- read_or_empty(zone_path)
nbhd <- read_or_empty(nbhd_path)

if (nrow(hist) == 0 && nrow(zone) == 0 && nrow(nbhd) == 0) {
  stop("[03] No working CSVs found. Run 01_scrape_historical.R and 02_scrape_zone_snapshots.R first.")
}

# Normalise the three sources to a common long-form schema.
# Season is normalised here: CMHC's DateString is "YYYY April" or
# "YYYY October" — strip the year prefix so the season filter matches.
unify <- function(df) {
  if (nrow(df) == 0) return(df)
  for (col in c("ParentUID", "ParentName")) {
    if (!col %in% names(df)) df[[col]] <- NA_character_
  }
  clean_season <- function(s) {
    s <- as.character(s)
    s <- sub("^\\s*\\d{4}\\s+", "", s)        # "2008 October" -> "October"
    s[s == "" | s == "NA"] <- NA_character_
    s
  }
  df %>%
    transmute(
      geoUid       = as.character(GeoUID),
      geoName      = as.character(GeoName),
      geoLevel     = as.character(GeoLevel),
      parentUid    = as.character(ParentUID),
      parentName   = as.character(ParentName),
      year         = as.integer(Year),
      season       = clean_season(Season),
      series       = as.character(Series),
      dimension    = as.character(Dimension),
      category     = as.character(Category),
      dwellingType = as.character(DwellingType),
      value        = as.numeric(Value),
      quality      = if ("Quality" %in% names(.)) as.character(Quality) else NA_character_
    )
}

all_records <- bind_rows(unify(hist), unify(zone), unify(nbhd))

message(sprintf("[03] Combined records: %d (%d distinct geographies)",
                nrow(all_records), dplyr::n_distinct(all_records$geoUid)))

# --- Write one shard per geography ------------------------------------------
shard_summaries <- all_records %>%
  group_by(geoUid, geoName, geoLevel, parentUid, parentName) %>%
  summarise(record_count = n(),
            year_min     = suppressWarnings(min(year, na.rm = TRUE)),
            year_max     = suppressWarnings(max(year, na.rm = TRUE)),
            .groups = "drop")

clear_dir <- function(dir) {
  if (dir.exists(dir)) {
    old <- list.files(dir, pattern = "\\.json$", full.names = TRUE)
    if (length(old)) file.remove(old)
  }
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
}
clear_dir(SERIES_DIR)

write_shard <- function(geoUid, geoName, geoLevel, parentUid, parentName) {
  rows <- all_records %>% filter(geoUid == !!geoUid)
  if (nrow(rows) == 0) return(NULL)
  payload <- list(
    geoUid     = geoUid,
    geoName    = geoName,
    geoLevel   = geoLevel,
    records    = rows %>%
      transmute(year, season, series, dimension, category, dwellingType,
                value, quality)
  )
  if (!is.na(parentUid)  && nzchar(parentUid))  payload$parentUid  <- parentUid
  if (!is.na(parentName) && nzchar(parentName)) payload$parentName <- parentName
  out <- file.path(SERIES_DIR, sprintf("%s_%s.json", geoLevel, geoUid))
  writeLines(toJSON(payload, auto_unbox = TRUE, na = "null", digits = 4),
             out, useBytes = TRUE)
  out
}

written <- pmap_chr(
  list(shard_summaries$geoUid, shard_summaries$geoName, shard_summaries$geoLevel,
       shard_summaries$parentUid, shard_summaries$parentName),
  function(...) {
    res <- write_shard(...)
    if (is.null(res)) NA_character_ else res
  }
)

message(sprintf("[03] Wrote %d shards to %s",
                sum(!is.na(written)), SERIES_DIR))

# --- Geographies index ------------------------------------------------------
geo_levels <- c("province", "cma", "csd", "zone", "neighbourhood")

geographies <- shard_summaries %>%
  arrange(geoLevel, geoName) %>%
  group_by(geoLevel) %>%
  group_split() %>%
  lapply(function(g) {
    level <- g$geoLevel[1]
    list(level = level,
         items = unname(lapply(seq_len(nrow(g)), function(i) {
           item <- list(uid     = g$geoUid[i],
                        name    = g$geoName[i],
                        yearMin = g$year_min[i],
                        yearMax = g$year_max[i])
           if (!is.na(g$parentUid[i]))  item$parentUid  <- g$parentUid[i]
           if (!is.na(g$parentName[i])) item$parentName <- g$parentName[i]
           item
         })))
  })

geos_by_level <- setNames(
  lapply(geographies, function(g) g$items),
  vapply(geographies, function(g) g$level, character(1))
)
# Ensure every level key exists, even if empty.
for (lvl in geo_levels) {
  if (is.null(geos_by_level[[lvl]])) geos_by_level[[lvl]] <- list()
}
# Reorder so the JSON keys follow our canonical level order.
geos_by_level <- geos_by_level[geo_levels]

geos_path <- file.path(WEB_DATA, "geographies.json")
writeLines(toJSON(list(version = 1,
                       generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
                       levels = geos_by_level),
                  auto_unbox = TRUE, pretty = TRUE),
           geos_path, useBytes = TRUE)
message(sprintf("[03] Wrote %s", geos_path))
