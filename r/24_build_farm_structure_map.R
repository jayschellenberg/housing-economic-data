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
# Sources (StatsCan WDS, read cell by cell via r/lib/statcan_wds.R — full-table
# downloads have been blocked for scripts since 2026-11):
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

suppressPackageStartupMessages({ library(dplyr); library(tidyr) })
source(file.path(.this_dir, "lib", "statcan_wds.R"))

CCS_RE <- "^(46|47|48|59)[0-9]{5}$"   # 7-digit CCSUID in MB/SK/AB/BC

# Western CCS members of a table's Geography dimension (position 1): memberId + CCSUID.
ccs_members <- function(meta) {
  g <- wds_members(meta, 1)
  g <- g[!is.na(g$code) & grepl(CCS_RE, g$code), c("memberId", "code")]
  if (anyDuplicated(g$code)) stop("[24] duplicate CCS codes in table metadata — aborting")
  names(g) <- c("geo", "uid")
  g
}
# The member id of the one member whose name matches `pattern` in dimension `position`.
member_id <- function(meta, position, pattern, fixed = FALSE) {
  m <- wds_members(meta, position)
  hit <- m$memberId[if (fixed) m$name == pattern else grepl(pattern, m$name)]
  if (length(hit) != 1L)
    stop(sprintf("[24] expected exactly one member matching '%s' in dimension %d, found %d — table layout changed",
                 pattern, position, length(hit)))
  hit
}
# Fetch a grid of geography x other-dimension members; returns uid + the member
# ids + value. Suppressed cells come back as NA.
fetch_grid <- function(pid, geo, grid) {
  req <- merge(geo, grid, by = NULL)
  req$coordinate <- do.call(wds_coordinate, unname(as.list(req[, c("geo", names(grid)), drop = FALSE])))
  got <- wds_fetch_coords(pid, req$coordinate, latest_n = 1L, tag = "24")
  got <- got[!duplicated(got$coordinate), c("coordinate", "value")]
  merge(req, got, by = "coordinate", all.x = TRUE)
}

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

message("[24] fetching 32-10-0249 (land use, 2021)")
m <- wds_cube_metadata(32100249)
lu <- fetch_grid(32100249, ccs_members(m), expand.grid(
  landuse = member_id(m, 2, "Total farm area", fixed = TRUE),
  uom     = c(farms = member_id(m, 3, "Number of farms reporting", fixed = TRUE),
              acres = member_id(m, 3, "Acres", fixed = TRUE))))
uom_farms <- member_id(m, 3, "Number of farms reporting", fixed = TRUE)
size_df <- lu |>
  transmute(uid, metric = ifelse(uom == uom_farms, "farms", "acres"), value) |>
  pivot_wider(names_from = metric, values_from = value) |>
  transmute(uid,
            farms = farms,
            size  = ifelse(!is.na(acres) & !is.na(farms) & farms > 0, round(acres / farms), NA_real_))

message("[24] fetching 32-10-0381 (operator age, 2021)")
m <- wds_cube_metadata(32100381)
age_df <- fetch_grid(32100381, ccs_members(m), expand.grid(
  nops = member_id(m, 2, "All farms"),
  char = member_id(m, 3, "Age - average"))) |>
  transmute(uid, age = round(value, 1)) |>
  distinct(uid, .keep_all = TRUE)

message("[24] fetching 32-10-0231 (farms by type, 2021)")
m <- wds_cube_metadata(32100231)
# A few farm-type names appear twice in the NAICS list (a group and its only child
# share a name, e.g. "Hog and pig farming", with identical counts) — take the
# first, which is the group. Note "Dairy cattle and milk production" sits under
# "Cattle ranching and farming"; both are kept, as the map legend always has.
types <- wds_members(m, 2)
types <- types[types$name %in% names(TYPE_LABEL), ]
types <- types[!duplicated(types$name), ]
if (nrow(types) != length(TYPE_LABEL))
  stop(sprintf("[24] found %d of %d farm types in 32-10-0231 — table layout changed", nrow(types), length(TYPE_LABEL)))
dom_df <- fetch_grid(32100231, ccs_members(m), expand.grid(naics_id = types$memberId)) |>
  transmute(uid, naics_id, naics = types$name[match(naics_id, types$memberId)], n = value) |>
  filter(!is.na(n), n > 0) |>
  arrange(uid, naics_id) |>          # table order, so ties resolve as the full-table read did
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
