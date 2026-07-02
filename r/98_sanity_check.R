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

read_prev_json <- function(path) {
  raw <- tryCatch(system2("git", c("show", paste0("HEAD:", path)),
                          stdout = TRUE, stderr = FALSE),
                  error = function(e) NULL)
  if (is.null(raw) || length(raw) == 0) return(NULL)
  tryCatch(jsonlite::fromJSON(paste(raw, collapse = "\n"), simplifyVector = FALSE),
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
