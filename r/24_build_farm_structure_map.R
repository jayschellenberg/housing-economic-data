# =============================================================================
# r/24_build_farm_structure_map.R
# Census Consolidated Subdivision (CCS) farm-structure data for the Agriculture
# tab's within-province choropleth map. 2021 Census of Agriculture, MB/SK/AB/BC.
#
# RUN-ONCE / MANUAL. The Census of Agriculture is five-yearly (2021 latest), so
# this is NOT part of the monthly refresh — like the boundary + census builds,
# its output is committed and only regenerated when a new census lands (~2027).
#   npm --prefix web run data:farmmap   (or: Rscript r/24_build_farm_structure_map.R)
#
# Sources (StatsCan WDS via cansim):
#   32-10-0249  Land use, 2021        -> total farm area (acres) + farm count -> avg size
#   32-10-0381  Operator characteristics, 2021 -> average operator age
#   32-10-0231  Farms by farm type, 2021 -> dominant (most common) farm type
#
# Output: web/public/data/geo/ag_ccs.json
#   { asOf, source, series: { "<CCSUID>": { size, farms, age, type } } }
# keyed by 7-digit CCSUID, which joins the <slug>_ccs.geojson feature ids.
# =============================================================================

.this_dir <- {
  args <- commandArgs(trailingOnly = FALSE)
  m <- sub("^--file=", "", grep("^--file=", args, value = TRUE))
  if (length(m)) dirname(normalizePath(m[1], winslash = "/")) else "r"
}
ROOT <- normalizePath(file.path(.this_dir, ".."), winslash = "/", mustWork = FALSE)

suppressPackageStartupMessages({
  if (!requireNamespace("cansim", quietly = TRUE)) install.packages("cansim", repos = "https://cloud.r-project.org")
  library(cansim); library(dplyr); library(tidyr)
})

CCS_RE <- "^(46|47|48|59)[0-9]{5}$"   # 7-digit CCSUID in MB/SK/AB/BC
ccs_rows <- function(d) dplyr::filter(d, grepl(CCS_RE, GeoUID))

# The mutually-exclusive NAICS farm types (they sum to the total), mapped to the
# short labels the map legend uses. Anything not listed folds into "Other".
TYPE_LABEL <- c(
  "Oilseed and grain farming"                        = "Grain & oilseed",
  "Vegetable and melon farming"                      = "Vegetable",
  "Fruit and tree nut farming"                        = "Fruit & nut",
  "Greenhouse, nursery and floriculture production"  = "Greenhouse & nursery",
  "Other crop farming"                                = "Other crop",
  "Cattle ranching and farming"                      = "Cattle",
  "Dairy cattle and milk production"                 = "Dairy",
  "Hog and pig farming"                              = "Hog",
  "Poultry and egg production"                        = "Poultry & egg",
  "Sheep and goat farming"                           = "Sheep & goat",
  "Other animal production"                          = "Other animal"
)

message("[24] downloading 32-10-0249 (land use, 2021)")
lu <- ccs_rows(get_cansim("32-10-0249"))
size_df <- lu |>
  filter(`Land use` == "Total farm area", `Unit of measure` %in% c("Acres", "Number of farms reporting")) |>
  transmute(uid = GeoUID,
            metric = ifelse(`Unit of measure` == "Acres", "acres", "farms"),
            value = suppressWarnings(as.numeric(VALUE))) |>
  pivot_wider(names_from = metric, values_from = value) |>
  transmute(uid,
            farms = farms,
            size  = ifelse(!is.na(acres) & !is.na(farms) & farms > 0, round(acres / farms), NA_real_))

message("[24] downloading 32-10-0381 (operator age, 2021)")
age_df <- ccs_rows(get_cansim("32-10-0381")) |>
  filter(grepl("All farms", `Farms according to the number of operators reported`),
         grepl("Age - average", Characteristics)) |>
  transmute(uid = GeoUID, age = round(suppressWarnings(as.numeric(VALUE)), 1)) |>
  distinct(uid, .keep_all = TRUE)

message("[24] downloading 32-10-0231 (farms by type, 2021)")
type_col <- "North American Industry Classification System (NAICS)"
dom_df <- ccs_rows(get_cansim("32-10-0231")) |>
  mutate(naics = as.character(.data[[type_col]])) |>   # column is a factor — use strings, not level codes
  filter(naics %in% names(TYPE_LABEL)) |>
  transmute(uid = GeoUID, naics, n = suppressWarnings(as.numeric(VALUE))) |>
  filter(!is.na(n), n > 0) |>
  group_by(uid) |>
  slice_max(order_by = n, n = 1, with_ties = FALSE) |>
  ungroup() |>
  transmute(uid, type = unname(TYPE_LABEL[naics]))

merged <- size_df |>
  full_join(age_df, by = "uid") |>
  full_join(dom_df, by = "uid") |>
  filter(grepl(CCS_RE, uid))

# Sanity gates — fail loudly rather than committing a gutted map.
n_ccs <- nrow(merged)
message(sprintf("[24] %d CCS rows (size:%d age:%d type:%d)",
                n_ccs, sum(!is.na(merged$size)), sum(!is.na(merged$age)), sum(!is.na(merged$type))))
if (n_ccs < 500) stop(sprintf("[24] only %d CCS (expected ~606) — aborting", n_ccs))
if (sum(!is.na(merged$size)) < 300) stop("[24] too few farm-size values — aborting")

series <- setNames(lapply(seq_len(nrow(merged)), function(i) {
  r <- merged[i, ]
  out <- list()
  if (!is.na(r$size))  out$size  <- r$size
  if (!is.na(r$farms)) out$farms <- r$farms
  if (!is.na(r$age))   out$age   <- r$age
  if (!is.na(r$type))  out$type  <- r$type
  out
}), merged$uid)

out <- list(
  asOf   = 2021,
  source = "Statistics Canada, 2021 Census of Agriculture — tables 32-10-0249 (land use), 32-10-0381 (operator characteristics), 32-10-0231 (farm type), by census consolidated subdivision.",
  series = series
)
out_path <- file.path(ROOT, "web", "public", "data", "geo", "ag_ccs.json")
dir.create(dirname(out_path), showWarnings = FALSE, recursive = TRUE)
jsonlite::write_json(out, out_path, auto_unbox = TRUE, null = "null")
message(sprintf("[24] wrote %s (%d CCS, %.1f KB)", out_path, length(series), file.size(out_path) / 1024))
