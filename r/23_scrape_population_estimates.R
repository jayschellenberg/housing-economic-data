# =============================================================================
# r/23_scrape_population_estimates.R
# Annual (July 1) population estimates for every western municipality (CSD)
# plus the four western provinces, from StatsCan table 17-10-0155
# (2021 boundaries, 2001 -> present, updated each January).
#
# Feeds the Census Profile tab's "Population — annual estimates" chart: the
# between-censuses trend that 5-yearly census counts can't show. Estimates are
# postcensal/intercensal and adjusted for census net undercoverage, so they
# deliberately differ from census counts — the output JSON carries that note.
#
# Output: web/public/data/housing/population_estimates.json
#   { source, sourceUrl, note, asOf, series: { "<uid>": [[year, value], ...] } }
# where <uid> is the 2-digit province SGC (46/47/48/59) or 7-digit CSDUID —
# the same uid space census_profile.json uses, so the frontend joins by key.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))

suppressPackageStartupMessages({
  if (!requireNamespace("cansim", quietly = TRUE)) install.packages("cansim", repos = "https://cloud.r-project.org")
  library(cansim)
  library(dplyr)
})

message("[popest] downloading table 17-10-0155 (full cube, ~5,200 geographies)")
tbl <- get_cansim("17-10-0155", timeout = 900)

d <- tbl |>
  transmute(uid  = GeoUID,
            year = as.integer(substr(REF_DATE, 1, 4)),
            value = suppressWarnings(as.numeric(VALUE))) |>
  filter(!is.na(value), !is.na(year),
         grepl("^(46|47|48|59)$|^(46|47|48|59)[0-9]{5}$", uid)) |>
  arrange(uid, year)

n_csd <- length(unique(d$uid[nchar(d$uid) == 7]))
provs <- intersect(unique(d$uid), c("46", "47", "48", "59"))
max_y <- max(d$year)
message(sprintf("[popest] kept %d rows: %d CSDs + %d provinces, %d-%d",
                nrow(d), n_csd, length(provs), min(d$year), max_y))

# Sanity gates — fail the refresh loudly rather than committing a gutted file
# (mirrors the r/98 schema-sanity philosophy).
if (n_csd < 1500) stop(sprintf("[popest] only %d western CSDs (expected ~1,750+) — aborting", n_csd))
if (length(provs) < 4) stop(sprintf("[popest] provinces missing (got %s) — aborting", paste(provs, collapse = ",")))
if (max_y < 2024) stop(sprintf("[popest] newest year is %d (stale table?) — aborting", max_y))

series <- lapply(split(d, d$uid), function(g) Map(function(y, v) list(y, v), g$year, g$value))

out <- list(
  source    = "Statistics Canada, table 17-10-0155-01 — Population estimates, July 1, by census subdivision, 2021 boundaries",
  sourceUrl = "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1710015501",
  note      = "July 1 postcensal/intercensal estimates, adjusted for census net undercoverage — values deliberately differ from census counts.",
  asOf      = max_y,
  series    = series
)

out_path <- file.path(ROOT, "web", "public", "data", "housing", "population_estimates.json")
dir.create(dirname(out_path), showWarnings = FALSE, recursive = TRUE)
jsonlite::write_json(out, out_path, auto_unbox = TRUE)
message(sprintf("[popest] wrote %s (%d series, %.1f KB)",
                out_path, length(series), file.size(out_path) / 1024))
