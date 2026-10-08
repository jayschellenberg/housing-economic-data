#!/usr/bin/env Rscript
# =============================================================================
# r/26_census_industry.R — Labour force by industry (NAICS sectors) from the
# 2021 and 2016 Censuses, for the Census Profile tab's community-profile
# narrative (economic-base paragraph + "labour force by industry" table).
#
# RUN-ONCE / MANUAL, like r/12: needs a CensusMapper key (CM_API_KEY), which CI
# does not have, so it is NOT in `data:all` or the GitHub Actions refresh. Run
# from census-refresh.bat or by hand:
#   R_ENVIRON_USER=C:/Users/Jason/Documents/.Renviron Rscript r/26_census_industry.R
#
# Geographies (uids match census_profile.json so the web joins on uid):
#   - PR / CMA / CD for MB + SK + AB + BC,
#   - every Manitoba CSD,
#   - optionally the Winnipeg virtual geographies (Community Area / Cluster /
#     Neighbourhood) aggregated from the 1,130 City DAs, 2021 only. The DA fetch
#     burns most of a free-tier daily quota, so it is opt-in:
#       CENSUS_INDUSTRY_WPG=1 Rscript r/26_census_industry.R
#     (resumable across days through the shared cancensus cache, same as r/12).
#
# The 20 NAICS sectors are the same vector tree in both censuses (NAICS 2017 vs
# NAICS 2012 differ only below the sector level), so fixed vector ids are used
# rather than r/12's label search.
#
# Output: web/public/data/housing/census_industry.json
#   { years, sectors:[{code,label}], regions:[{uid,name,level,
#       data:{ "<year>": { labourForce, notApplicable, counts:[20 ints] } }}] }
#   `counts` are ordered like `sectors`; labourForce = "All industries" total
#   (the share denominator), notApplicable = "Industry – not applicable".
# =============================================================================

suppressPackageStartupMessages({
  for (p in c("cancensus", "jsonlite")) {
    if (!requireNamespace(p, quietly = TRUE)) install.packages(p, repos = "https://cloud.r-project.org")
    library(p, character.only = TRUE)
  }
})

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

# ---- Paths -----------------------------------------------------------------
.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
WEB_DATA   <- normalizePath(file.path(.this_dir, "..", "web", "public", "data"), winslash = "/", mustWork = FALSE)
WPG_LOOKUP <- file.path(.this_dir, "lib", "wpg_geography_lookup.csv")

# ---- API key + cache (identical to r/12) ----------------------------------
.key <- getOption("cancensus.api_key", "")
if (!nzchar(.key)) .key <- Sys.getenv("CM_API_KEY", Sys.getenv("CANCENSUS_API_KEY", ""))
if (!nzchar(.key)) {
  stop("No CensusMapper API key. Set CM_API_KEY (see r/12_census_profile.R), e.g.\n",
       "  CM_API_KEY=CensusMapper_xxx Rscript r/26_census_industry.R", call. = FALSE)
}
options(cancensus.api_key = .key)
.cache <- getOption("cancensus.cache_path", Sys.getenv("CM_CACHE_PATH", ""))
if (!nzchar(.cache) || !dir.exists(.cache)) {
  .cache <- path.expand("~/cancensus_cache")
  dir.create(.cache, recursive = TRUE, showWarnings = FALSE)
}
options(cancensus.cache_path = .cache)

# ---- Vectors ---------------------------------------------------------------
# Sector order = NAICS code order; both datasets expose the sectors as 20
# consecutive "Total" vectors stepping by 3 (Total / Male / Female).
SECTORS <- data.frame(
  code  = c("11", "21", "22", "23", "31-33", "41", "44-45", "48-49", "51", "52",
            "53", "54", "55", "56", "61", "62", "71", "72", "81", "91"),
  label = c("Agriculture, forestry, fishing and hunting",
            "Mining, quarrying, and oil and gas extraction",
            "Utilities", "Construction", "Manufacturing", "Wholesale trade", "Retail trade",
            "Transportation and warehousing", "Information and cultural industries",
            "Finance and insurance", "Real estate and rental and leasing",
            "Professional, scientific and technical services",
            "Management of companies and enterprises",
            "Administrative and support, waste management and remediation services",
            "Educational services", "Health care and social assistance",
            "Arts, entertainment and recreation", "Accommodation and food services",
            "Other services (except public administration)", "Public administration"),
  stringsAsFactors = FALSE
)
VECTORS <- list(
  `2021` = list(dataset = "CA21", total = "v_CA21_6600", na = "v_CA21_6603", all = "v_CA21_6606",
                sectors = sprintf("v_CA21_%d", seq(6609, by = 3, length.out = 20))),
  `2016` = list(dataset = "CA16", total = "v_CA16_5693", na = "v_CA16_5696", all = "v_CA16_5699",
                sectors = sprintf("v_CA16_%d", seq(5702, by = 3, length.out = 20)))
)

MB_PR  <- "46"
ALL_PR <- c("46", "47", "48", "59")      # MB, SK, AB, BC — PR/CMA/CD coverage

# Pull the named vector columns out of a get_census() frame (cancensus names
# columns "<vid>: <label>", so match on the id prefix).
vec_col <- function(df, vid) {
  col <- grep(sprintf("^%s(:|$)", vid), names(df), value = TRUE)[1]
  if (is.na(col)) rep(NA_real_, nrow(df)) else suppressWarnings(as.numeric(df[[col]]))
}
to_rows <- function(df, v, uid_col = "GeoUID") {
  out <- data.frame(uid = as.character(df[[uid_col]]),
                    name = as.character(df$`Region Name` %||% df$name %||% NA),
                    Population = suppressWarnings(as.numeric(df$Population)),
                    labourForce = vec_col(df, v$all), notApplicable = vec_col(df, v$na),
                    stringsAsFactors = FALSE)
  for (i in seq_along(v$sectors)) out[[paste0("s", i)]] <- vec_col(df, v$sectors[[i]])
  out
}
vec_list <- function(v) c(v$total, v$na, v$all, v$sectors)

fetch_level <- function(year, level, prs) {
  v <- VECTORS[[year]]
  df <- get_census(dataset = v$dataset, regions = list(PR = prs), level = level,
                   vectors = vec_list(v), use_cache = TRUE, quiet = TRUE, geo_format = NA)
  to_rows(df, v)
}

# Winnipeg DAs in chunks (r/12's recipe: 18 per call, cache-resumable).
fetch_wpg_das <- function(year, chunk_size = 18) {
  v <- VECTORS[[year]]
  da_ids <- unique(as.character(read.csv(WPG_LOOKUP, stringsAsFactors = FALSE)$DA_UID))
  chunks <- split(da_ids, ceiling(seq_along(da_ids) / chunk_size))
  parts <- vector("list", length(chunks))
  for (i in seq_along(chunks)) {
    message(sprintf("    Winnipeg DA chunk %d/%d", i, length(chunks)))
    df <- get_census(dataset = v$dataset, regions = list(DA = chunks[[i]]), level = "DA",
                     vectors = vec_list(v), use_cache = TRUE, quiet = TRUE, geo_format = NA)
    parts[[i]] <- to_rows(df, v)
    Sys.sleep(0.3)
  }
  do.call(rbind, parts)
}

# ---- Fetch -----------------------------------------------------------------
# rows[[year]] = data.frame(uid, name, level, …) across every standard level.
rows <- list()
for (year in names(VECTORS)) {
  message(sprintf("[26] %s Census — labour force by industry", year))
  parts <- list()
  for (level in c("PR", "CMA", "CD")) {
    message(sprintf("  %s (%s)", level, paste(ALL_PR, collapse = ",")))
    r <- fetch_level(year, level, ALL_PR); r$level <- level; parts[[level]] <- r
  }
  message("  CSD (Manitoba)")
  r <- fetch_level(year, "CSD", MB_PR); r$level <- "CSD"; parts$CSD <- r
  rows[[year]] <- do.call(rbind, parts)
}

# ---- Winnipeg virtual geographies (opt-in, 2021 only) ---------------------
wpg_virtual <- NULL
if (nzchar(Sys.getenv("CENSUS_INDUSTRY_WPG", ""))) {
  message("[26] Winnipeg DAs (2021) for Community Area / Cluster / Neighbourhood…")
  wpg_da <- tryCatch(fetch_wpg_das("2021"), error = function(e) {
    message("[26] Winnipeg DA fetch failed (quota?) — skipping virtual geographies: ", conditionMessage(e)); NULL
  })
  if (!is.null(wpg_da)) {
    lk <- read.csv(WPG_LOOKUP, stringsAsFactors = FALSE)
    lk <- lk[!is.na(lk$Neighbourhood) & nzchar(lk$Neighbourhood), ]
    m <- match(wpg_da$uid, as.character(lk$DA_UID))
    wpg_da$CommunityArea <- lk$CommunityArea[m]; wpg_da$Cluster <- lk$Cluster[m]; wpg_da$Neighbourhood <- lk$Neighbourhood[m]
    wj <- wpg_da[!is.na(wpg_da$CommunityArea), ]
    cnt_cols <- c("labourForce", "notApplicable", paste0("s", seq_len(20)))
    agg <- function(group_col, tag, prefix) {
      out <- list()
      for (g in sort(unique(wj[[group_col]]))) {
        sub <- wj[wj[[group_col]] == g, ]
        s <- lapply(cnt_cols, function(k) if (all(is.na(sub[[k]]))) NA_real_ else sum(sub[[k]], na.rm = TRUE))
        names(s) <- cnt_cols
        out[[length(out) + 1]] <- c(list(uid = paste0(prefix, ":", g), name = g, level = tag,
                                         Population = sum(sub$Population, na.rm = TRUE)), s)
      }
      do.call(rbind, lapply(out, as.data.frame, stringsAsFactors = FALSE))
    }
    wpg_virtual <- rbind(agg("CommunityArea", "WPG_CA", "WPG_CA"),
                         agg("Cluster", "WPG_Cluster", "WPG_CL"),
                         agg("Neighbourhood", "WPG_Nbhd", "WPG_NB"))
  }
} else {
  message("[26] Winnipeg virtual geographies skipped (set CENSUS_INDUSTRY_WPG=1 to include; costs ~1,130 DA regions of quota).")
}

# ---- Assemble --------------------------------------------------------------
round_or_na <- function(x) if (is.null(x) || is.na(x)) NA else round(as.numeric(x))
year_block <- function(r) list(
  labourForce   = round_or_na(r$labourForce),
  notApplicable = round_or_na(r$notApplicable),
  counts        = lapply(seq_len(20), function(i) round_or_na(r[[paste0("s", i)]]))
)

regions <- list()
keys <- unique(unlist(lapply(rows, function(r) r$uid)))
for (uid in keys) {
  first <- NULL; data <- list()
  for (year in names(VECTORS)) {
    r <- rows[[year]][rows[[year]]$uid == uid, , drop = FALSE]
    if (!nrow(r) || is.na(r$labourForce[1])) next
    if (is.null(first)) first <- r[1, ]
    data[[year]] <- year_block(r[1, ])
  }
  if (!length(data)) next
  regions[[length(regions) + 1]] <- list(uid = uid, name = first$name, level = first$level, data = data)
}
if (!is.null(wpg_virtual)) {
  for (i in seq_len(nrow(wpg_virtual))) {
    r <- wpg_virtual[i, ]
    regions[[length(regions) + 1]] <- list(uid = r$uid, name = r$name, level = r$level,
                                           data = list(`2021` = year_block(r)))
  }
}

payload <- list(
  source      = "Statistics Canada, Census of Population (2016, 2021) — labour force aged 15+ by industry (NAICS sectors), via CensusMapper / cancensus",
  sourceUrl   = "https://censusmapper.ca/",
  generatedBy = "r/26_census_industry.R",
  generatedAt = format(Sys.time(), "%Y-%m-%d"),
  years       = as.list(rev(names(VECTORS))),
  sectors     = lapply(seq_len(nrow(SECTORS)), function(i) list(code = SECTORS$code[i], label = SECTORS$label[i])),
  regions     = regions
)
out_dir <- file.path(WEB_DATA, "housing")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_path <- file.path(out_dir, "census_industry.json")
writeLines(toJSON(payload, auto_unbox = TRUE, na = "null", digits = 10), out_path, useBytes = TRUE)
message(sprintf("[26] Wrote %s (%d regions)", out_path, length(regions)))
