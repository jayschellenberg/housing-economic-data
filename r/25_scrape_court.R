# =============================================================================
# r/25_scrape_court.R
# Manitoba Court of King's Bench pre-judgment / post-judgment interest rates
# for the "Court" tab. Writes web/public/data/court/court_interest.json with:
#   - rates : one row per quarter (effective date, quarter label, rate %), as
#             published in the court's single on-page table. ONE rate applies
#             to both pre-judgment and post-judgment interest.
#   - the page's own provenance: the registrar's "Dated this ..." line and the
#     "Information on this page last updated on ..." stamp, so the tab can show
#     which vintage of the official table it is reproducing.
#
# The rate is set quarterly under section 79(1) of The Court of King's Bench
# Act, Part XIV. The court publishes back to January 1, 2014 only — there is no
# earlier history on the page, so the series starts there.
#
# Monthly (a new quarter posts four times a year, so a monthly scrape catches
# one within weeks). When the newest quarter or its rate differs from the
# committed file, writes data/court_new_rate.txt so CI can raise an alert.
#
# Parsing is base-R regex over the raw HTML (same approach as r/19) — no rvest
# dependency for one small, stable two-column table.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # ROOT, DATA_DIR, WEB_DATA, jsonlite
suppressPackageStartupMessages({
  if (!requireNamespace("httr", quietly = TRUE)) install.packages("httr", repos = "https://cloud.r-project.org")
  library(httr)
})
`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

COURT_URL <- "https://www.manitobacourts.mb.ca/court-of-queens-bench/procedure-rules-and-forms/pre-judgment-and-post-judgment-interest/"
RULES_URL <- "https://www.manitobacourts.mb.ca/court-of-queens-bench/procedure-rules-and-forms/statutes-and-rules/"
HOME_URL  <- "https://www.manitobacourts.mb.ca/"

OUT_DIR   <- file.path(WEB_DATA, "court"); dir.create(OUT_DIR, showWarnings = FALSE, recursive = TRUE)
OUT_PATH  <- file.path(OUT_DIR, "court_interest.json")
FLAG_PATH <- file.path(DATA_DIR, "court_new_rate.txt")

# Minimum rows we expect to parse. The page has published ~51 quarters since
# 2014 and only grows; well under that means the markup changed under us and we
# should fail rather than commit a truncated table.
MIN_ROWS     <- 40
ALLOW_SHRINK <- identical(Sys.getenv("COURT_ALLOW_SHRINK"), "1")

# Month-name → number. Explicit rather than strptime("%B"), whose month names
# follow LC_TIME — the CI runner's locale is not this laptop's.
MONTHS <- c(January = 1L, February = 2L, March = 3L, April = 4L, May = 5L, June = 6L,
            July = 7L, August = 8L, September = 9L, October = 10L, November = 11L, December = 12L)

strip_tags <- function(x) {
  x <- gsub("<[^>]*>", " ", x)
  x <- gsub("&nbsp;|&#160;|&#xa0;", " ", x, ignore.case = TRUE)
  x <- gsub("&amp;", "&", x)
  # The page carries LITERAL non-breaking spaces (U+00A0), not entities — 16 of
  # them, including inside date cells. PCRE's \s does not match U+00A0 without
  # UCP, so without this the date regex silently drops those rows (36 parsed
  # instead of 51). Normalise every unicode space to ASCII before collapsing.
  x <- gsub("[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]", " ", x, perl = TRUE)
  gsub("^\\s+|\\s+$", "", gsub("\\s+", " ", x))
}

# --- 1. Fetch ----------------------------------------------------------------
resp <- tryCatch(
  GET(COURT_URL, user_agent("housing-economic-data/1.0 (+https://housing-economic-data.vercel.app)"),
      timeout(60)),
  error = function(e) NULL)
if (is.null(resp) || status_code(resp) != 200) {
  stop(sprintf("[25] court interest page unreachable (%s) — keeping the committed JSON",
               if (is.null(resp)) "no response" else status_code(resp)))
}
html <- content(resp, as = "text", encoding = "UTF-8")

# --- 2. Parse the rate table -------------------------------------------------
tbl <- regmatches(html, regexpr("<table[\\s\\S]*?</table>", html, perl = TRUE))
if (length(tbl) == 0) stop("[25] no <table> found on the court interest page — markup changed?")

tr <- regmatches(tbl[1], gregexpr("<tr[\\s\\S]*?</tr>", tbl[1], perl = TRUE))[[1]]
parsed <- lapply(tr, function(row) {
  cells <- regmatches(row, gregexpr("<t[dh][^>]*>[\\s\\S]*?</t[dh]>", row, perl = TRUE))[[1]]
  if (length(cells) < 2) return(NULL)
  cells <- vapply(cells, strip_tags, character(1), USE.NAMES = FALSE)
  date_txt <- cells[1]
  rate_txt <- cells[2]
  # "July 2, 2026" / "October 1,  2017" (the page's own double space).
  m <- regmatches(date_txt, regexec("^([A-Z][a-z]+)\\s+(\\d{1,2}),\\s*(\\d{4})$", date_txt))[[1]]
  if (length(m) != 4) return(NULL)                      # header row, or a note
  mon <- MONTHS[[m[2]]]
  if (is.null(mon) || is.na(mon)) return(NULL)
  if (!grepl("^\\d+(\\.\\d+)?$", rate_txt)) return(NULL)
  day  <- as.integer(m[3])
  year <- as.integer(m[4])
  list(
    effectiveDate = sprintf("%04d-%02d-%02d", year, mon, day),
    quarter       = sprintf("%d-Q%d", year, ((mon - 1L) %/% 3L) + 1L),
    ratePct       = as.numeric(rate_txt),
    # Keep the published string too: the court writes "2.5" some quarters and
    # "5.00" others, and a reproduction should be able to show it verbatim.
    rateText      = rate_txt
  )
})
rates <- Filter(Negate(is.null), parsed)
if (length(rates) == 0) stop("[25] parsed 0 rate rows — markup changed?")

# Newest first, matching how the court presents it.
ord <- order(vapply(rates, function(x) x$effectiveDate, character(1)), decreasing = TRUE)
rates <- rates[ord]

vals <- vapply(rates, function(x) x$ratePct, numeric(1))
if (any(!is.finite(vals)) || any(vals < 0) || any(vals > 30)) {
  stop("[25] rate outside the plausible 0-30% range — parse error, refusing to write")
}
if (anyDuplicated(vapply(rates, function(x) x$effectiveDate, character(1)))) {
  stop("[25] duplicate effective dates parsed — parse error, refusing to write")
}
if (length(rates) < MIN_ROWS && !ALLOW_SHRINK) {
  stop(sprintf("[25] only %d rows parsed (expected >= %d) — refusing to overwrite. Set COURT_ALLOW_SHRINK=1 if the court genuinely shortened the table.",
               length(rates), MIN_ROWS))
}

# --- 3. Page provenance ------------------------------------------------------
txt <- strip_tags(html)
grab <- function(pattern) {
  m <- regmatches(txt, regexec(pattern, txt, perl = TRUE))[[1]]
  if (length(m) >= 2) m[2] else NA_character_
}
dated       <- grab("Dated this\\s+([A-Z][a-z]+\\s+\\d{1,2},\\s*\\d{4})")
page_updated<- grab("last updated on\\s+([A-Z][a-z]+\\s+\\d{1,2},\\s*\\d{4})")
# Everything between the date line and "Registrar" is the signatory's name;
# strip a trailing "Acting" so the name doesn't absorb the qualifier (the role
# is recorded separately below).
signed_by   <- grab("Dated this\\s+[A-Z][a-z]+\\s+\\d{1,2},\\s*\\d{4}\\s+(.{2,60}?)\\s*(?:Acting\\s+)?Registrar")
if (!is.na(signed_by)) signed_by <- sub("\\s*Acting$", "", trimws(signed_by))
signed_role <- if (grepl("Acting Registrar", txt)) "Acting Registrar, Court of King's Bench" else "Registrar, Court of King's Bench"

# --- 4. New-rate alert flag --------------------------------------------------
prev <- if (file.exists(OUT_PATH)) {
  tryCatch(jsonlite::read_json(OUT_PATH, simplifyVector = FALSE), error = function(e) NULL)
} else NULL

if (file.exists(FLAG_PATH)) file.remove(FLAG_PATH)
prev_rates <- prev$rates %||% list()
if (length(prev_rates) > 0) {
  if (length(rates) < length(prev_rates) && !ALLOW_SHRINK) {
    stop(sprintf("[25] parsed %d rows but the committed file has %d — refusing to shrink the table. Set COURT_ALLOW_SHRINK=1 to override.",
                 length(rates), length(prev_rates)))
  }
  prev_top <- prev_rates[[1]]
  new_top  <- rates[[1]]
  if (!identical(prev_top$effectiveDate, new_top$effectiveDate) ||
      !isTRUE(all.equal(as.numeric(prev_top$ratePct), new_top$ratePct))) {
    msg <- sprintf("Manitoba Court of King's Bench pre/post-judgment interest rate: %.2f%% effective %s (previously %.2f%% effective %s).",
                   new_top$ratePct, new_top$effectiveDate,
                   as.numeric(prev_top$ratePct %||% NA), prev_top$effectiveDate %||% "?")
    writeLines(msg, FLAG_PATH)
    message("[25] NEW RATE/QUARTER DETECTED -> ", FLAG_PATH)
  }
}

# --- 5. Write JSON -----------------------------------------------------------
payload <- list(
  source      = "Court of King's Bench of Manitoba",
  sourceUrl   = COURT_URL,
  rulesUrl    = RULES_URL,
  courtUrl    = HOME_URL,
  # Cited by name + section rather than by link: the court's page carries no
  # link to the Act, and the old CCSM c.C280 URL no longer resolves after the
  # King's Bench renaming. Don't invent one.
  actCitation = "The Court of King's Bench Act, Part XIV, s. 79(1)",
  scrapedAt   = format(Sys.Date()),
  pageUpdated = page_updated,
  dated       = dated,
  signedBy    = signed_by,
  signedRole  = signed_role,
  rates       = rates
)
writeLines(jsonlite::toJSON(payload, auto_unbox = TRUE, na = "null", digits = 4),
           OUT_PATH, useBytes = TRUE)
message(sprintf("[25] Wrote %s (%d quarters, %s..%s, current %.2f%%)",
                OUT_PATH, length(rates),
                rates[[length(rates)]]$effectiveDate, rates[[1]]$effectiveDate,
                rates[[1]]$ratePct))
