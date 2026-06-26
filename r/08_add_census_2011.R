# =============================================================================
# r/08_add_census_2011.R
# Add 2011 National Household Survey housing (dwelling condition + period of
# construction) onto web/public/data/housing/census_housing.json, which r/07
# already populated with 2021 + 2016. 2011 has no clean API, so this parses the
# NHS Profile comprehensive download files (catalogue 99-004-XWE2011001):
#   - CPT (FMT=CSV101): Canada + provinces/territories       (char col 5, total col 7)
#   - CSD (FMT=CSV301): per-province CSD files; we use MAN only (char col 8, total col 10)
# Run AFTER r/07. Census is 5-yearly + the 2011 NHS is voluntary (lower
# small-area reliability), so this is a run-on-demand generator.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
source(file.path(.this_dir, "lib", "cmhc_helpers.R"))   # jsonlite, dplyr, DATA_DIR, WEB_DATA
suppressPackageStartupMessages({ if (!requireNamespace("utils", quietly = TRUE)) {} })

PERIOD_LABELS_2011 <- c("1960 or before", "1961 to 1980", "1981 to 1990",
                        "1991 to 2000", "2001 to 2005", "2006 to 2011")   # 6 bands
CONDITION_LABELS_2011 <- c("Regular maintenance or minor repairs needed",
                           "Major repairs needed")
PERIOD_HDR <- "Total number of occupied private dwellings by period of construction"
COND_HDR   <- "Total number of occupied private dwellings by condition of dwelling"

dl_dir <- file.path(DATA_DIR, "nhs2011"); dir.create(dl_dir, showWarnings = FALSE, recursive = TRUE)
fetch_unzip <- function(fmt, sub) {
  outdir <- file.path(dl_dir, sub)
  if (!dir.exists(outdir) || !length(list.files(outdir, pattern = "\\.csv$"))) {
    zp <- file.path(dl_dir, paste0(sub, ".zip"))
    url <- sprintf("https://www12.statcan.gc.ca/nhs-enm/2011/dp-pd/prof/details/download-telecharger/comprehensive/comp_download.cfm?CTLG=99-004-XWE2011001&FMT=%s&Lang=E", fmt)
    message(sprintf("[08] downloading %s ...", fmt))
    utils::download.file(url, zp, mode = "wb", quiet = TRUE)
    utils::unzip(zp, exdir = outdir)
  }
  outdir
}

numv <- function(x) { v <- suppressWarnings(as.numeric(gsub("[^0-9.]", "", x))); v }

# Positional parse: within a geography's rows (file order), the 6 period bands
# follow the PERIOD_HDR row and the 2 condition values follow COND_HDR.
parse_geo_block <- function(geo_rows, char, total) {
  ch <- trimws(char)
  pi <- which(ch == PERIOD_HDR)
  ci <- which(ch == COND_HDR)
  if (!length(pi)) return(NULL)
  pi <- pi[1]
  tot <- numv(total[pi])
  age <- vapply(1:6, function(k) numv(total[pi + k]), numeric(1))
  cond <- if (length(ci)) c(numv(total[ci[1] + 1]), numv(total[ci[1] + 2])) else c(NA_real_, NA_real_)
  if (!is.finite(tot) || tot <= 0) return(NULL)
  list(total = round(tot), age = age, condition = cond)
}

# CPT file — Canada (geo "01") + provinces (2-digit). No header; skip title line.
parse_cpt <- function(path) {
  df <- utils::read.csv(path, header = FALSE, skip = 1, colClasses = "character",
                        stringsAsFactors = FALSE, quote = "\"", fill = TRUE, fileEncoding = "latin1")
  out <- list()
  for (g in unique(df$V1)) {
    if (!(g == "01" || grepl("^[0-9]{2}$", g))) next
    blk <- parse_geo_block(df[df$V1 == g, ], df$V5[df$V1 == g], df$V7[df$V1 == g])
    if (!is.null(blk)) out[[g]] <- blk
  }
  out
}

# CSD per-province file — header row; Geo_Code col1, Characteristic col8, Total col10.
parse_csd <- function(path) {
  df <- utils::read.csv(path, header = TRUE, colClasses = "character",
                        stringsAsFactors = FALSE, quote = "\"", fill = TRUE, fileEncoding = "latin1")
  geo <- df[[1]]; char <- df[[8]]; total <- df[[10]]
  out <- list()
  for (g in unique(geo)) {
    if (!grepl("^[0-9]{7}$", g)) next
    sel <- geo == g
    blk <- parse_geo_block(df[sel, ], char[sel], total[sel])
    if (!is.null(blk)) out[[g]] <- blk
  }
  out
}

message("[08] parsing 2011 NHS files...")
cpt_dir <- fetch_unzip("CSV101", "cpt")
csd_dir <- fetch_unzip("CSV301", "csd")
cpt <- parse_cpt(list.files(cpt_dir, pattern = "-101\\.csv$", full.names = TRUE)[1])
# Manitoba + western municipalities (SK/AB/BC). Each province's CSDs are a
# separate file in the comprehensive download; parse MB plus the three western
# provinces so their municipalities gain the 2011 back-year — the target western
# baseline (2006 stays Manitoba-only). Other provinces are not modelled.
CSD_FILES <- c("-301-MAN\\.csv$", "-301-SASK\\.csv$", "-301-ALTA\\.csv$", "-301-BC\\.csv$")
csd <- list()
for (pat in CSD_FILES) {
  f <- list.files(csd_dir, pattern = pat, full.names = TRUE)[1]
  if (!is.na(f) && file.exists(f)) csd <- c(csd, parse_csd(f))
}
lookup2011 <- c(cpt, csd)
message(sprintf("[08] 2011 geographies parsed: %d (CPT %d, CSD %d)",
                length(lookup2011), length(cpt), length(csd)))

# --- Merge onto the existing multi-year JSON ---------------------------------
json_path <- file.path(WEB_DATA, "housing", "census_housing.json")
doc <- jsonlite::read_json(json_path)
cleanv <- function(v) lapply(v, function(x) if (length(x) && is.finite(x)) round(x) else NA)
added <- 0
doc$areas <- lapply(doc$areas, function(a) {
  key <- if (identical(a$level, "country")) "01" else a$uid
  b <- lookup2011[[key]]
  if (!is.null(b)) {
    a$census[["2011"]] <- list(total = b$total, age = cleanv(b$age), condition = cleanv(b$condition))
    added <<- added + 1
  }
  a
})
# Additive — keep any year already present (e.g. 2006 from r/09) so this can be
# re-run standalone without dropping the deeper Manitoba back-years.
doc$censusYears <- as.list(sort(unique(c(unlist(doc$censusYears), "2021", "2016", "2011")),
                                decreasing = TRUE))
doc$periodLabels[["2011"]]    <- as.list(PERIOD_LABELS_2011)
doc$conditionLabels[["2011"]] <- as.list(CONDITION_LABELS_2011)
doc$source <- "Statistics Canada, Census of Population — 2021 (98-10-0233), 2016 (Census Profile) and 2011 (NHS Profile)"

writeLines(jsonlite::toJSON(doc, auto_unbox = TRUE, na = "null"), json_path, useBytes = TRUE)
message(sprintf("[08] Added 2011 to %d areas; wrote %s", added, json_path))
