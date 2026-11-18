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
  library(httr)
  library(dplyr)
})

# Fetched cell by cell through the WDS coordinate API, NOT as a full-table
# download: StatsCan began blocking programmatic full-table downloads
# (cansim::get_cansim / the n1/tbl/csv zips) in 2026-11, while metadata, vector
# and coordinate calls kept working. The cube has ONE dimension (Geography), so
# a coordinate is just "<memberId>.0.0.0.0.0.0.0.0.0" and the whole western
# pull is ~10 small requests.
`%||%` <- function(a, b) if (is.null(a)) b else a
PID   <- 17100155L
WDS   <- "https://www150.statcan.gc.ca/t1/wds/rest"
BATCH <- 250L   # 500 coordinates in one request is rejected (HTTP 416)

wds_post <- function(method, body, what) {
  for (attempt in 1:3) {
    resp <- tryCatch(POST(file.path(WDS, method), body = body, encode = "json",
                          add_headers(`Content-Type` = "application/json"), timeout(120)),
                     error = function(e) NULL)
    if (!is.null(resp) && status_code(resp) == 200) {
      parsed <- tryCatch(content(resp, as = "parsed", encoding = "UTF-8"), error = function(e) NULL)
      if (is.list(parsed) && length(parsed)) return(parsed)
    }
    Sys.sleep(2 * attempt)
  }
  stop(sprintf("[popest] %s failed after 3 attempts — aborting (committed file untouched)", what))
}

# --- 1. Cube metadata: geography members + how many years the table holds ----
message("[popest] fetching cube metadata for 17-10-0155")
meta <- wds_post("getCubeMetadata", list(list(productId = PID)), "cube metadata")[[1]]
if (!identical(meta$status, "SUCCESS")) stop("[popest] cube metadata status is not SUCCESS — aborting")
dims <- meta$object$dimension
if (length(dims) != 1L)
  stop(sprintf("[popest] table now has %d dimensions (expected 1: Geography) — coordinates need rework", length(dims)))
gm <- dims[[1]]$member
geo <- data.frame(
  memberId = vapply(gm, function(m) as.integer(m$memberId), integer(1)),
  uid      = vapply(gm, function(m) as.character(m$classificationCode %||% NA_character_), character(1)),
  stringsAsFactors = FALSE
)
geo <- geo[!is.na(geo$uid) & grepl("^(46|47|48|59)$|^(46|47|48|59)[0-9]{5}$", geo$uid), ]
if (anyDuplicated(geo$uid)) stop("[popest] duplicate geography codes in cube metadata — aborting")
geo$coordinate <- sprintf("%d.0.0.0.0.0.0.0.0.0", geo$memberId)

# Ask for every period the cube holds, plus a margin so a newly added year is
# never cut off (latestN larger than the series length just returns it all).
y0 <- as.integer(substr(meta$object$cubeStartDate, 1, 4))
y1 <- as.integer(substr(meta$object$cubeEndDate, 1, 4))
LATEST_N <- (y1 - y0 + 1L) + 5L
message(sprintf("[popest] %d western geographies, cube spans %d-%d; fetching in batches of %d",
                nrow(geo), y0, y1, BATCH))

# --- 2. Batch fetch. WDS does NOT preserve request order but echoes each
#        coordinate, so rows are keyed by the returned coordinate. ------------
fetch_batch <- function(coords, b) {
  body <- lapply(coords, function(co) list(productId = PID, coordinate = co, latestN = LATEST_N))
  parsed <- wds_post("getDataFromCubePidCoordAndLatestNPeriods", body, sprintf("batch %d", b))
  rows <- lapply(parsed, function(p) {
    if (!identical(p$status, "SUCCESS")) return(NULL)
    dp <- p$object$vectorDataPoint
    if (!length(dp)) return(NULL)
    data.frame(
      coordinate = as.character(p$object$coordinate),
      year  = vapply(dp, function(x) as.integer(substr(x$refPer %||% NA_character_, 1, 4)), integer(1)),
      value = vapply(dp, function(x) {
        v <- x$value
        if (is.null(v) || !length(v)) return(NA_real_)
        # value is in units of 10^scalarFactorCode (0 = persons for this table)
        suppressWarnings(as.numeric(v)) * 10^as.integer(x$scalarFactorCode %||% 0L)
      }, numeric(1)),
      stringsAsFactors = FALSE
    )
  })
  got <- unique(unlist(lapply(rows, function(r) r$coordinate[1])))
  if (length(setdiff(coords, got)))
    stop(sprintf("[popest] batch %d: %d of %d coordinates came back without data — aborting (committed file untouched)",
                 b, length(setdiff(coords, got)), length(coords)))
  do.call(rbind, rows)
}

n_batches <- ceiling(nrow(geo) / BATCH)
raw <- do.call(rbind, lapply(seq_len(n_batches), function(b) {
  lo <- (b - 1L) * BATCH + 1L; hi <- min(b * BATCH, nrow(geo))
  out <- fetch_batch(geo$coordinate[lo:hi], b)
  message(sprintf("[popest]   batch %d/%d (%d geographies)", b, n_batches, hi))
  Sys.sleep(0.25)
  out
}))

d <- raw |>
  inner_join(geo[, c("coordinate", "uid")], by = "coordinate") |>
  select(uid, year, value) |>
  filter(!is.na(value), !is.na(year)) |>
  distinct(uid, year, .keep_all = TRUE) |>
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
# A short series means a truncated fetch (latestN too small / partial response),
# not a real gap: every western geography carries the full run of years.
n_pts <- table(d$uid)
if (mean(n_pts == max(n_pts)) < 0.99)
  stop(sprintf("[popest] %d of %d series are shorter than %d years (truncated fetch?) — aborting",
               sum(n_pts < max(n_pts)), length(n_pts), max(n_pts)))

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
