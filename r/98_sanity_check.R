# =============================================================================
# r/98_sanity_check.R
# Refresh-workflow regression gate. Compares freshly-built manifests against
# the previously-committed versions and aborts (exit 1) if record / shard /
# series counts shrink beyond a tolerance. Catches the failure mode where
# the scrape returned partial data and would silently overwrite full shards
# (e.g. the 2026-06-09 zone/neighbourhood Apartment+Row loss).
#
# Reads previous state via `git show HEAD:<path>` — the refresh workflow must
# checkout with fetch-depth >= 2 for this to resolve.
#
# Override: set REFRESH_ALLOW_SHRINK=1 to permit a known-good shrink (e.g.
# CMHC retired a series; an indicator was disabled in the catalog).
#
# Tolerance: drops up to SHRINK_TOLERANCE_PCT (default 10%) are warnings;
# anything beyond aborts.
# =============================================================================

SHRINK_TOLERANCE_PCT <- as.numeric(Sys.getenv("REFRESH_SHRINK_TOLERANCE_PCT", unset = "10"))
ALLOW_SHRINK         <- identical(Sys.getenv("REFRESH_ALLOW_SHRINK"), "1")
# Hard floor: even with REFRESH_ALLOW_SHRINK=1, refuse a catastrophic drop. An
# operator approving an intended retirement should never also wave through a
# 60%+ loss from an outage that returned near-empty data. Raise the env var only
# if a loss that large is genuinely intended.
HARD_FLOOR_PCT       <- as.numeric(Sys.getenv("REFRESH_HARD_FLOOR_PCT", unset = "60"))

# `git show` goes to a temp file, not stdout = TRUE: R splits captured lines at
# ~8 KB, which corrupts minified JSON (every indicator shard is one long line).
read_prev_json <- function(path) {
  tmp <- tempfile(fileext = ".json")
  on.exit(unlink(tmp), add = TRUE)
  status <- tryCatch(system2("git", c("show", paste0("HEAD:", path)),
                             stdout = tmp, stderr = FALSE),
                     error = function(e) 1L)
  if (!identical(as.integer(status), 0L) || !file.exists(tmp) || file.size(tmp) == 0) return(NULL)
  tryCatch(jsonlite::fromJSON(tmp, simplifyVector = FALSE),
           error = function(e) NULL)
}

read_curr_json <- function(path) {
  if (!file.exists(path)) return(NULL)
  tryCatch(jsonlite::fromJSON(path, simplifyVector = FALSE),
           error = function(e) NULL)
}

# Helper: pull a scalar metric out of a manifest, defaulting to 0 if absent.
metric <- function(m, key) {
  v <- m[[key]]
  if (is.null(v) || !is.finite(suppressWarnings(as.numeric(v)))) 0L
  else as.numeric(v)
}

check_one <- function(label, prev_val, curr_val) {
  if (prev_val == 0) {
    list(label = label, prev = prev_val, curr = curr_val,
         delta_pct = NA_real_, ok = TRUE,
         note = "no prior value (first run / new metric)")
  } else {
    delta <- (curr_val - prev_val) / prev_val * 100
    ok <- delta >= -SHRINK_TOLERANCE_PCT
    note <- sprintf("%+.2f%%", delta)
    list(label = label, prev = prev_val, curr = curr_val,
         delta_pct = delta, ok = ok, note = note)
  }
}

`%||%` <- function(a, b) if (is.null(a)) b else a

# Quiet jsonlite — the workflow runs this standalone, so guarantee it's loaded.
suppressPackageStartupMessages(library(jsonlite))

# Paths are relative to repo root (cwd at workflow invocation).
manifest_path   <- "web/public/data/manifest.json"
indicators_path <- "web/public/data/indicators-manifest.json"

prev_m <- read_prev_json(manifest_path)
curr_m <- read_curr_json(manifest_path)
prev_i <- read_prev_json(indicators_path)
curr_i <- read_curr_json(indicators_path)

if (is.null(curr_m)) {
  cat("[sanity] current manifest.json missing — aborting.\n")
  quit(status = 1L)
}

checks <- list()
if (!is.null(prev_m)) {
  checks <- c(checks, list(
    check_one("rental.totalRecords",        metric(prev_m, "totalRecords"),
                                            metric(curr_m, "totalRecords")),
    check_one("rental.shardCount",          metric(prev_m, "shardCount"),
                                            metric(curr_m, "shardCount")),
    check_one("starts.totalRecords",        metric(prev_m, "startsTotalRecords"),
                                            metric(curr_m, "startsTotalRecords")),
    check_one("starts.shardCount",          metric(prev_m, "startsShardCount"),
                                            metric(curr_m, "startsShardCount")),
    check_one("secondary.totalRecords",     metric(prev_m, "secondaryTotalRecords"),
                                            metric(curr_m, "secondaryTotalRecords"))
  ))
} else {
  cat("[sanity] no prior manifest.json on HEAD — first-run mode.\n")
}

if (!is.null(prev_i) && !is.null(curr_i)) {
  checks <- c(checks, list(
    check_one("indicators.totalSeries",     metric(prev_i, "totalSeries"),
                                            metric(curr_i, "totalSeries")),
    check_one("indicators.totalRecords",    metric(prev_i, "totalRecords"),
                                            metric(curr_i, "totalRecords"))
  ))
}

cat(sprintf("\n[sanity] tolerance: -%g%% per metric; override REFRESH_ALLOW_SHRINK=%s\n\n",
            SHRINK_TOLERANCE_PCT, if (ALLOW_SHRINK) "1 (set)" else "0 (unset)"))
cat(sprintf("%-30s %12s %12s %10s  %s\n",
            "metric", "prev", "curr", "delta", "status"))
cat(strrep("-", 80), "\n", sep = "")
for (c in checks) {
  cat(sprintf("%-30s %12s %12s %10s  %s\n",
              c$label,
              format(c$prev, big.mark = ",", scientific = FALSE),
              format(c$curr, big.mark = ",", scientific = FALSE),
              c$note,
              if (c$ok) "OK" else "SHRINK"))
}

# --- Schema check: category sets per (series, dimension) vs HEAD -------------
# A CMHC rename ("Total" -> "All") or a dropped category keeps record counts
# identical, so it slips past the count checks above — but it breaks the
# frontend, which filters by exact category strings. Abort if any category
# present on HEAD has disappeared. Override with REFRESH_ALLOW_SCHEMA_CHANGE=1
# for an intended CMHC change (then update the frontend category constants).
ALLOW_SCHEMA_CHANGE <- identical(Sys.getenv("REFRESH_ALLOW_SCHEMA_CHANGE"), "1")
prev_s <- read_prev_json("web/public/data/schema.json")
curr_s <- read_curr_json("web/public/data/schema.json")

schema_removals  <- character(0)
schema_additions <- character(0)
if (is.null(prev_s)) {
  cat("\n[sanity] no prior schema.json on HEAD — skipping category-set check (first run).\n")
} else if (is.null(curr_s)) {
  cat("\n[sanity] current schema.json missing — skipping category-set check.\n")
} else {
  for (grp in c("rental", "starts")) {
    pg <- prev_s[[grp]]; cg <- curr_s[[grp]]
    if (is.null(pg)) next
    for (series in names(pg)) {
      for (dim in names(pg[[series]])) {
        prev_cats <- as.character(unlist(pg[[series]][[dim]]))
        curr_cats <- as.character(unlist((cg[[series]] %||% list())[[dim]] %||% list()))
        removed <- setdiff(prev_cats, curr_cats)
        added   <- setdiff(curr_cats, prev_cats)
        if (length(removed))
          schema_removals <- c(schema_removals, sprintf("%s / %s / %s: removed %s",
            grp, series, dim, paste(sprintf('"%s"', removed), collapse = ", ")))
        if (length(added))
          schema_additions <- c(schema_additions, sprintf("%s / %s / %s: added %s",
            grp, series, dim, paste(sprintf('"%s"', added), collapse = ", ")))
      }
    }
  }
}
if (length(schema_additions)) {
  cat("\n[sanity] new categories appeared (informational):\n")
  for (a in schema_additions) cat("  +", a, "\n")
}
if (length(schema_removals)) {
  cat("\n[sanity] CATEGORY SET CHANGED — categories present last refresh are gone:\n")
  for (r in schema_removals) cat("  -", r, "\n")
  if (!ALLOW_SCHEMA_CHANGE) {
    cat("\n[sanity] Aborting: a rename/removal like this breaks the frontend's exact category filters.\n")
    cat("[sanity] If this CMHC change is intended, update the frontend category constants and set REFRESH_ALLOW_SCHEMA_CHANGE=1.\n")
    quit(status = 1L)
  }
  cat("\n[sanity] REFRESH_ALLOW_SCHEMA_CHANGE=1 — proceeding despite category changes.\n")
}

# --- Scale check: percent series silently rescaled to fractions --------------
# Record counts don't move when an upstream changes units, so the 2026-09-07
# cansim 0.5.0 bump (val_norm started dividing Percent/Rate by 100) shipped
# 0.05% unemployment for weeks. For every "percent" indicator series, compare
# the latest up-to-24 dates it shares with HEAD; a median ratio around 1/100
# means the values were divided by 100. Only drops abort — the refresh that
# repairs such a bug jumps ~100x UP and must be allowed through. Override with
# REFRESH_ALLOW_SCALE_CHANGE=1 for an intended unit change.
ALLOW_SCALE_CHANGE <- identical(Sys.getenv("REFRESH_ALLOW_SCALE_CHANGE"), "1")
indicators_dir <- "web/public/data/indicators"
scale_drops <- character(0)
shard_paths <- setdiff(list.files(indicators_dir, pattern = "\\.json$", full.names = TRUE),
                       file.path(indicators_dir, "_catalog.json"))
for (path in shard_paths) {
  path <- gsub("\\\\", "/", path)
  curr_doc <- read_curr_json(path)
  prev_doc <- read_prev_json(path)
  if (is.null(curr_doc) || is.null(prev_doc)) next
  pct_ids <- vapply(Filter(function(s) identical(s$units, "percent"), curr_doc$series %||% list()),
                    function(s) s$id %||% "", character(1))
  if (!length(pct_ids)) next
  recs_df <- function(doc) {
    r <- Filter(function(x) (x$id %||% "") %in% pct_ids && is.numeric(x$value), doc$records %||% list())
    if (!length(r)) return(NULL)
    data.frame(id    = vapply(r, function(x) x$id, ""),
               date  = vapply(r, function(x) as.character(x$date), ""),
               value = vapply(r, function(x) as.numeric(x$value), 0),
               stringsAsFactors = FALSE)
  }
  cr <- recs_df(curr_doc); pr <- recs_df(prev_doc)
  if (is.null(cr) || is.null(pr)) next
  both <- merge(cr, pr, by = c("id", "date"), suffixes = c(".curr", ".prev"))
  both <- both[is.finite(both$value.prev) & abs(both$value.prev) > 1e-9 & is.finite(both$value.curr), ]
  for (sid in unique(both$id)) {
    b <- both[both$id == sid, ]
    b <- head(b[order(b$date, decreasing = TRUE), ], 24)
    if (nrow(b) < 3) next
    ratio <- stats::median(b$value.curr / b$value.prev)
    if (is.finite(ratio) && ratio > 0.002 && ratio < 0.05)
      scale_drops <- c(scale_drops, sprintf("%s (%s): recent values ~%.0fx smaller than HEAD (median ratio %.4f over %d dates; e.g. %s: %g -> %g)",
        sid, basename(path), 1 / ratio, ratio, nrow(b), b$date[1], b$value.prev[1], b$value.curr[1]))
  }
}
if (length(scale_drops)) {
  cat("\n[sanity] PERCENT SERIES RESCALED — values dropped ~100x vs the last refresh (percent -> fraction?):\n")
  for (s in scale_drops) cat("  -", s, "\n")
  if (!ALLOW_SCALE_CHANGE) {
    cat("\n[sanity] Aborting: check the scraper's value column / scalar handling (e.g. cansim val_norm normalising percents).\n")
    cat("[sanity] If this unit change is intended, set REFRESH_ALLOW_SCALE_CHANGE=1.\n")
    quit(status = 1L)
  }
  cat("\n[sanity] REFRESH_ALLOW_SCALE_CHANGE=1 — proceeding despite the rescale.\n")
} else {
  cat("\n[sanity] percent series scale check: OK.\n")
}

failures <- Filter(function(c) !c$ok, checks)
if (length(failures) == 0) {
  cat("\n[sanity] all metrics within tolerance.\n")
  quit(status = 0L)
}
if (ALLOW_SHRINK) {
  catastrophic <- Filter(function(c) is.finite(c$delta_pct) && c$delta_pct <= -HARD_FLOOR_PCT, failures)
  if (length(catastrophic) > 0) {
    labels <- paste(vapply(catastrophic,
                           function(c) sprintf("%s (%.1f%%)", c$label, c$delta_pct), ""),
                    collapse = ", ")
    cat(sprintf("\n[sanity] REFRESH_ALLOW_SHRINK=1, but %d metric(s) dropped past the hard floor (-%g%%): %s.\n",
                length(catastrophic), HARD_FLOOR_PCT, labels))
    cat("[sanity] A drop this large is almost always an outage returning near-empty data, not an intentional retirement — refusing to overwrite. Raise REFRESH_HARD_FLOOR_PCT only if this loss is genuinely intended.\n")
    quit(status = 1L)
  }
  cat(sprintf("\n[sanity] %d metric(s) shrank beyond tolerance, but REFRESH_ALLOW_SHRINK=1 — proceeding.\n",
              length(failures)))
  quit(status = 0L)
}
cat(sprintf("\n[sanity] %d metric(s) shrank beyond -%g%% — aborting refresh.\n",
            length(failures), SHRINK_TOLERANCE_PCT))
cat("[sanity] If this is intentional, set REFRESH_ALLOW_SHRINK=1 on the workflow run.\n")
quit(status = 1L)
