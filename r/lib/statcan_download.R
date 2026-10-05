# StatCan www12 (census) downloads — with a manual-download fallback.
#
# Since late Sept 2026 www12.statcan.gc.ca sits behind a Cloudflare bot check:
# scripted requests (any user agent) get HTTP 403 + a "Just a moment..." HTML
# page instead of the file. www150 (cansim / WDS tables) is NOT affected.
#
# Fallback: download the file by hand in a normal browser (Chrome passes the
# check), save it into STATCAN_MANUAL_DIR under the exact name the error message
# gives, and re-run the script. Default folder: r/lib/cache/statcan-manual/
# (git-ignored); override with the STATCAN_MANUAL_DIR environment variable.
# (The 2016 per-area REST lookups moved to CensusMapper — r/lib/census2016.R.)
#
# Needs ROOT (repo root) defined before sourcing — cmhc_helpers.R sets it.

STATCAN_MANUAL_DIR <- Sys.getenv("STATCAN_MANUAL_DIR",
                                 file.path(ROOT, "r", "lib", "cache", "statcan-manual"))

# TRUE when a response body / downloaded file is the bot-check page, not data.
statcan_is_blocked <- function(x) {
  if (is.raw(x)) x <- rawToChar(x[x != as.raw(0)])
  grepl("Just a moment|cf-chl|challenge-platform|Performing security verification", x, useBytes = TRUE)
}

# Classed error so "best-effort" callers (tryCatch → NULL) can re-raise a block
# instead of silently dropping a geography level.
statcan_blocked_stop <- function(msg) {
  stop(structure(class = c("statcan_blocked", "error", "condition"),
                 list(message = msg, call = NULL)))
}

# Fetch one www12 file to `dest`. Uses <STATCAN_MANUAL_DIR>/<manual_name> when
# present; otherwise tries the scripted download and, if StatCan blocks it,
# stops with instructions for the manual download. Zips are checked for the
# "PK" signature so a saved HTML challenge page is never mistaken for data.
statcan_fetch_file <- function(url, dest, manual_name, tag = "statcan") {
  is_zip <- grepl("\\.zip$", manual_name, ignore.case = TRUE)
  valid <- function(p) {
    if (!file.exists(p) || file.info(p)$size < 1000) return(FALSE)
    head <- readBin(p, "raw", 4000)
    if (is_zip) identical(head[1:2], charToRaw("PK")) else !statcan_is_blocked(head)
  }
  manual <- file.path(STATCAN_MANUAL_DIR, manual_name)
  if (file.exists(manual)) {
    if (!valid(manual))
      stop(sprintf("[%s] %s is not a valid %s (bot-check page saved by mistake?) — re-download it in Chrome.",
                   tag, manual, if (is_zip) "zip" else "file"), call. = FALSE)
    message(sprintf("[%s] using manual download %s", tag, manual))
    if (normalizePath(manual, mustWork = FALSE) != normalizePath(dest, mustWork = FALSE))
      file.copy(manual, dest, overwrite = TRUE)
    return(invisible(dest))
  }
  old <- getOption("timeout"); options(timeout = max(600, old)); on.exit(options(timeout = old), add = TRUE)
  ok <- tryCatch({ utils::download.file(url, dest, mode = "wb", quiet = TRUE); TRUE },
                 error = function(e) FALSE, warning = function(w) FALSE)
  if (ok && valid(dest)) return(invisible(dest))
  if (file.exists(dest)) unlink(dest)
  dir.create(STATCAN_MANUAL_DIR, recursive = TRUE, showWarnings = FALSE)
  statcan_blocked_stop(sprintf(paste0(
    "[%s] StatCan blocked the scripted download (Cloudflare bot check on www12).\n",
    "  1. Open this URL in Chrome:\n     %s\n",
    "  2. Save the file as:\n     %s\n",
    "  3. Re-run this script."),
    tag, url, normalizePath(manual, winslash = "/", mustWork = FALSE)))
}
