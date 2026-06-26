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
csd_path  <- file.path(DATA_DIR, "csd_snapshots.csv")

read_or_empty <- function(p) {
  if (!file.exists(p)) return(tibble::tibble())
  tryCatch(read_csv(p, show_col_types = FALSE), error = function(e) tibble::tibble())
}

hist <- read_or_empty(hist_path)
zone <- read_or_empty(zone_path)
nbhd <- read_or_empty(nbhd_path)
csd  <- read_or_empty(csd_path)

if (nrow(hist) == 0 && nrow(zone) == 0 && nrow(nbhd) == 0 && nrow(csd) == 0) {
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

all_records <- bind_rows(unify(hist), unify(zone), unify(nbhd), unify(csd))

# --- Non-Manitoba year floor -------------------------------------------------
# Manitoba keeps full history; every other province is limited to a rolling
# 10-year window to keep the dataset compact (user decision, 2026-06). The floor
# is computed from the current year so it advances automatically each refresh.
# Resolve each record's province from its geo UID / parent CMA (CMAS comes from
# cmhc_helpers) and drop pre-floor rows for non-MB geos.
FULL_HISTORY_PROV <- c("46")   # Manitoba province UID
NONMB_MIN_YEAR    <- as.integer(format(Sys.Date(), "%Y")) - 10L   # rolling 10-yr
resolve_prov <- function(geoUid, geoLevel, parentUid) {
  gu <- as.character(geoUid); pu <- as.character(parentUid); lv <- as.character(geoLevel)
  prov <- rep(NA_character_, length(gu))
  prov[lv == "province"] <- gu[lv == "province"]
  m_cma <- lv == "cma";                       prov[m_cma] <- CMAS$prov_uid[match(gu[m_cma], CMAS$uid)]
  m_zn  <- lv %in% c("zone", "neighbourhood"); prov[m_zn]  <- CMAS$prov_uid[match(pu[m_zn], CMAS$uid)]
  # CSDs arrive two ways: r/02 snapshots use a synthetic "<CMA>-<slug>" UID with
  # the parent CMA set (resolve via the parent); r/01 centre CSDs have a real SGC
  # UID (province = first two digits) and no CMA parent. Prefer parent, else UID.
  m_csd   <- lv == "csd"
  csd_par <- CMAS$prov_uid[match(pu, CMAS$uid)]
  prov[m_csd] <- ifelse(!is.na(csd_par[m_csd]), csd_par[m_csd], substr(gu[m_csd], 1, 2))
  prov
}
apply_year_floor <- function(df, uidCol, levelCol, parentCol, yearCol) {
  if (nrow(df) == 0) return(df)
  prov <- resolve_prov(df[[uidCol]], df[[levelCol]], df[[parentCol]])
  yr   <- suppressWarnings(as.integer(df[[yearCol]]))
  keep <- (prov %in% FULL_HISTORY_PROV) | (yr >= NONMB_MIN_YEAR)
  keep[is.na(keep)] <- TRUE   # never drop a row on a parse failure
  df[keep, , drop = FALSE]
}
n_before <- nrow(all_records)
all_records <- apply_year_floor(all_records, "geoUid", "geoLevel", "parentUid", "year")
message(sprintf("[03] Year floor: dropped %d non-MB rows before %d",
                n_before - nrow(all_records), NONMB_MIN_YEAR))

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
                        prov    = resolve_prov(g$geoUid[i], level, g$parentUid[i]),
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

# =============================================================================
# --- Scss housing starts shards ---------------------------------------------
# Read housing_starts.csv (if present) and emit per-geography shards under
# web/public/data/starts/. Kept in a separate tree from the Rms shards so the
# Housing Starts tab can load only what it needs.
# =============================================================================
starts_path <- file.path(DATA_DIR, "housing_starts.csv")
starts <- read_or_empty(starts_path)

if (nrow(starts) > 0) {
  # Same non-MB 2015+ floor as the rental records above.
  n_starts0 <- nrow(starts)
  starts <- apply_year_floor(starts, "GeoUID", "GeoLevel", "ParentUID", "Year")
  message(sprintf("[03] Starts year floor: dropped %d non-MB rows before %d",
                  n_starts0 - nrow(starts), NONMB_MIN_YEAR))
  message(sprintf("[03] Scss records to shard: %d (%d distinct geographies)",
                  nrow(starts), dplyr::n_distinct(starts$GeoUID)))

  STARTS_DIR <- file.path(WEB_DATA, "starts")
  clear_dir(STARTS_DIR)

  starts_summaries <- starts %>%
    group_by(GeoUID, GeoName, GeoLevel, ParentUID, ParentName) %>%
    summarise(record_count = n(),
              year_min     = suppressWarnings(min(Year, na.rm = TRUE)),
              year_max     = suppressWarnings(max(Year, na.rm = TRUE)),
              .groups = "drop")

  write_starts_shard <- function(geoUid, geoName, geoLevel, parentUid, parentName) {
    rows <- starts %>% filter(GeoUID == !!geoUid)
    if (nrow(rows) == 0) return(NULL)
    payload <- list(
      geoUid   = geoUid,
      geoName  = geoName,
      geoLevel = geoLevel,
      records  = rows %>%
        transmute(year = Year, quarter = Quarter, frequency = Frequency,
                  series = Series, dimension = Dimension, category = Category,
                  value = Value, quality = Quality)
    )
    if (!is.na(parentUid)  && nzchar(parentUid))  payload$parentUid  <- parentUid
    if (!is.na(parentName) && nzchar(parentName)) payload$parentName <- parentName
    out <- file.path(STARTS_DIR, sprintf("%s_%s.json", geoLevel, geoUid))
    writeLines(toJSON(payload, auto_unbox = TRUE, na = "null", digits = 4),
               out, useBytes = TRUE)
    out
  }

  written_starts <- pmap_chr(
    list(starts_summaries$GeoUID, starts_summaries$GeoName, starts_summaries$GeoLevel,
         starts_summaries$ParentUID, starts_summaries$ParentName),
    function(...) {
      res <- write_starts_shard(...)
      if (is.null(res)) NA_character_ else res
    })
  message(sprintf("[03] Wrote %d Scss shards to %s",
                  sum(!is.na(written_starts)), STARTS_DIR))

  # Also write a starts-geographies index so the new tab's dropdowns know
  # exactly which geos have Scss data (which may differ slightly from Rms).
  starts_levels <- starts_summaries %>%
    arrange(GeoLevel, GeoName) %>%
    group_by(GeoLevel) %>%
    group_split() %>%
    lapply(function(g) {
      list(level = g$GeoLevel[1],
           items = unname(lapply(seq_len(nrow(g)), function(i) {
             item <- list(uid = g$GeoUID[i], name = g$GeoName[i],
                          yearMin = g$year_min[i], yearMax = g$year_max[i])
             if (!is.na(g$ParentUID[i]))  item$parentUid  <- g$ParentUID[i]
             if (!is.na(g$ParentName[i])) item$parentName <- g$ParentName[i]
             item
           })))
    })
  starts_by_level <- setNames(
    lapply(starts_levels, function(g) g$items),
    vapply(starts_levels, function(g) g$level, character(1)))
  for (lvl in geo_levels) if (is.null(starts_by_level[[lvl]])) starts_by_level[[lvl]] <- list()
  starts_by_level <- starts_by_level[geo_levels]

  starts_geos_path <- file.path(WEB_DATA, "starts-geographies.json")
  writeLines(toJSON(list(version = 1,
                         generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
                         levels = starts_by_level),
                    auto_unbox = TRUE, pretty = TRUE),
             starts_geos_path, useBytes = TRUE)
  message(sprintf("[03] Wrote %s", starts_geos_path))
} else {
  message("[03] housing_starts.csv not found; skipping Scss shards.")
}
