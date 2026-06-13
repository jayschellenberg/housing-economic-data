# =============================================================================
# r/lib/cmhc_helpers.R
# Shared geography lookups, dimension catalogs, and safe API wrappers.
# Sourced by every other script in r/.
# =============================================================================

suppressPackageStartupMessages({
  if (!requireNamespace("cmhc",     quietly = TRUE)) install.packages("cmhc",     repos = "https://cloud.r-project.org")
  if (!requireNamespace("dplyr",    quietly = TRUE)) install.packages("dplyr",    repos = "https://cloud.r-project.org")
  if (!requireNamespace("tidyr",    quietly = TRUE)) install.packages("tidyr",    repos = "https://cloud.r-project.org")
  if (!requireNamespace("purrr",    quietly = TRUE)) install.packages("purrr",    repos = "https://cloud.r-project.org")
  if (!requireNamespace("readr",    quietly = TRUE)) install.packages("readr",    repos = "https://cloud.r-project.org")
  if (!requireNamespace("jsonlite", quietly = TRUE)) install.packages("jsonlite", repos = "https://cloud.r-project.org")
  library(cmhc)
  library(dplyr)
  library(tidyr)
  library(purrr)
  library(readr)
  library(jsonlite)
})

# --- Paths -------------------------------------------------------------------
# Anchor everything to the repo root regardless of where the script is run from.
# Callers should set .this_dir (absolute path to r/) before sourcing helpers.

repo_root <- function() {
  if (exists(".this_dir", envir = .GlobalEnv) && nzchar(get(".this_dir", envir = .GlobalEnv))) {
    # .this_dir is the absolute path to r/ — repo root is one level up.
    return(normalizePath(file.path(get(".this_dir", envir = .GlobalEnv), ".."),
                         winslash = "/", mustWork = TRUE))
  }
  # Fall back: assume cwd is repo root.
  normalizePath(getwd(), winslash = "/", mustWork = TRUE)
}

ROOT      <- repo_root()
DATA_DIR  <- file.path(ROOT, "data")
WEB_DATA  <- file.path(ROOT, "web", "public", "data")
SERIES_DIR <- file.path(WEB_DATA, "series")

dir.create(DATA_DIR,   recursive = TRUE, showWarnings = FALSE)
dir.create(WEB_DATA,   recursive = TRUE, showWarnings = FALSE)
dir.create(SERIES_DIR, recursive = TRUE, showWarnings = FALSE)

# --- Geographies -------------------------------------------------------------
# Manitoba province + CMA/CA + the small-centre CSDs CMHC reports separately.
# (Other Manitoba CSDs are discovered dynamically by 00_audit_geographies.R.)

MB_PROVINCE_UID <- "46"

MB_CMAS <- tibble::tribble(
  ~uid,  ~name,                 ~level,
  "602", "Winnipeg",            "cma",
  "610", "Brandon",             "cma",
  "607", "Portage la Prairie",  "cma",
  "605", "Steinbach",           "cma",
  "640", "Thompson",            "cma",
  "603", "Winkler",             "cma"
)

# CSDs CMHC reports as their own centre on the HMIP portal.
MB_CENTRE_CSDS <- tibble::tribble(
  ~uid,        ~name,             ~level,
  "4602036",   "Hanover RM",      "csd",
  "4613047",   "Selkirk CY",      "csd",
  "4613043",   "St. Andrews RM",  "csd"
)

# Survey Zone breakdowns are supported by these CMAs only (rest return empty).
ZONE_CMAS <- c("Winnipeg" = "602", "Brandon" = "610",
               "Portage la Prairie" = "607", "Steinbach" = "605",
               "Thompson" = "640", "Winkler" = "603")

# --- RMS catalog -------------------------------------------------------------
# Hand-curated valid (series x dimension) combinations for the Primary Rental
# Survey. Cross-checked with cmhc 0.2.10; the capabilities script overwrites
# this with the live introspection result when available.

RMS_SERIES <- c("Vacancy Rate", "Availability Rate", "Average Rent",
                "Median Rent", "Average Rent Change", "Rental Universe")

RMS_DIMENSIONS_BY_SERIES <- list(
  "Vacancy Rate"        = c("Bedroom Type", "Year of Construction",
                            "Structure Size", "Rent Ranges"),
  "Availability Rate"   = c("Bedroom Type", "Year of Construction",
                            "Structure Size"),
  "Average Rent"        = c("Bedroom Type", "Year of Construction",
                            "Structure Size"),
  "Median Rent"         = c("Bedroom Type", "Year of Construction",
                            "Structure Size"),
  "Average Rent Change" = c("Bedroom Type"),
  # Rent Ranges intentionally absent — probed against the live CMHC API
  # on 2026-06-13 and returns "Dimension Rent Ranges for Rental Universe
  # and survey Rms does not exist or is not supported."
  "Rental Universe"     = c("Bedroom Type", "Year of Construction",
                            "Structure Size")
)

DWELLING_TYPES <- c("All", "Apartment", "Row")

# Map our internal dwelling-type label → the cmhc package's filter value.
# Probed list_cmhc_filters: dwelling_type_desc_en accepts exactly
# "Row / Apartment", "Row", "Apartment". The "Row / Apartment" value is the
# combined-universe default; we surface it as "All" in the UI.
DWELLING_TYPE_FILTER <- c(
  "All"       = "Row / Apartment",
  "Apartment" = "Apartment",
  "Row"       = "Row"
)

# Canonical category orderings used by the frontend for legend sorting.
CATEGORY_ORDER <- list(
  "Bedroom Type" = c("Studio", "1 Bedroom", "2 Bedroom",
                     "3 Bedroom +", "Total"),
  "Year of Construction" = c("Before 1960", "1960 - 1979", "1980 - 1999",
                              "2000 or Later"),
  "Structure Size" = c("3 to 5 units", "6 to 19 units", "20 to 49 units",
                       "50 to 199 units", "200 + units"),
  "Rent Ranges" = c("Less Than $750", "$750 - $999", "$1,000 - $1,249",
                    "$1,250 - $1,499", "$1,500 +")
)

# --- Safe API wrapper --------------------------------------------------------
# Wraps get_cmhc() with tryCatch, normalises factor columns, and tags every
# returned row with the call parameters so we can identify it after binding.

safe_get_cmhc <- function(series, dimension, breakdown, geo_uid,
                          geo_name = NA_character_, geo_level = NA_character_,
                          dwelling_type = "All", year = NULL, season = NULL,
                          quiet = FALSE) {
  filter_args <- list()
  if (!is.null(dwelling_type) && dwelling_type != "All") {
    filter_args$dwelling_type_desc_en <- DWELLING_TYPE_FILTER[[dwelling_type]]
  }

  call_args <- list(
    survey    = "Rms",
    series    = series,
    dimension = dimension,
    breakdown = breakdown,
    geo_uid   = geo_uid
  )
  if (!is.null(year))   call_args$year   <- year
  if (!is.null(season)) call_args$season <- season
  if (length(filter_args)) call_args$filters <- filter_args

  tryCatch({
    df <- do.call(cmhc::get_cmhc, call_args)
    if (is.null(df) || nrow(df) == 0) {
      if (!quiet) message(sprintf("    -> 0 rows (%s | %s | %s | %s | dw=%s)",
                                  series, dimension, breakdown, geo_name, dwelling_type))
      return(NULL)
    }
    df <- df %>%
      mutate(across(where(is.factor), as.character)) %>%
      mutate(
        Series       = series,
        Dimension    = dimension,
        Breakdown    = breakdown,
        DwellingType = dwelling_type,
        GeoUID       = geo_uid,
        GeoName      = geo_name,
        GeoLevel     = geo_level
      )
    if (!quiet) message(sprintf("    -> %d rows (%s | %s | %s | %s | dw=%s)",
                                nrow(df), series, dimension, breakdown, geo_name, dwelling_type))
    df
  }, error = function(e) {
    if (!quiet) message(sprintf("    -> ERROR: %s", conditionMessage(e)))
    NULL
  })
}

# Pluck the actual category column out of a cmhc data frame (the dimension
# name appears as a column when the breakdown is "Historical Time Periods").
extract_category <- function(df, dimension) {
  if (dimension %in% names(df)) return(as.character(df[[dimension]]))
  rep(NA_character_, nrow(df))
}

# Extract a Date or Year column and return integer year.
extract_year <- function(df) {
  if ("Date" %in% names(df)) {
    return(as.integer(format(as.Date(df$Date), "%Y")))
  }
  if ("Year" %in% names(df)) return(as.integer(df$Year))
  rep(NA_integer_, nrow(df))
}

# Find the zone/neighbourhood/CSD name column in a snapshot data frame.
# Different cmhc versions return slightly different column names.
extract_zone_name <- function(df) {
  candidates <- intersect(names(df),
                          c("Survey Zone", "Survey Zones",
                            "Neighbourhood", "Neighbourhoods",
                            "Census Subdivision", "Name", "name"))
  if (length(candidates)) return(as.character(df[[candidates[1]]]))
  rep(NA_character_, nrow(df))
}

message(sprintf("[helpers] root = %s", ROOT))
