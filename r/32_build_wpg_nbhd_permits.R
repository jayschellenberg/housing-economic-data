#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# 32_build_wpg_nbhd_permits.R — recent development (building permits, last
# five years) for each Winnipeg neighbourhood / cluster / community area, for
# the Census Profile tab's community-profile narrative (Phase 3, Winnipeg mode):
#
#   "New construction has been steady over the past five years, mainly
#    apartment buildings."
#
# Source: City of Winnipeg Open Data (Open Government Licence – Winnipeg) —
#   Detailed Building Permit Data (Socrata it4w-cpf4; 2010 → present, weekly),
#   with Neighbourhoods (8k6x-xxsy) + Census Boundaries (re9d-6c9j, 2016).
#
# Method: permits issued in the WINDOW_MONTHS before the latest issue date,
#   located by their point. Dwelling units created / lost are summed by building
#   type (any work type — conversions add units too), units lost from
#   demolitions and changes of use only; new non-residential
#   buildings = "Construct New" permits in the Non-Residential group. The
#   narrative scales net units against the area's census households.
#
# RUN-ONCE / MANUAL (needs sf; downloads cached under r/lib/cache/geo/ — delete
# wpg_permits_recent.csv to refresh):
#   Rscript r/32_build_wpg_nbhd_permits.R
#
# Output: web/public/data/geo/wpg_nbhd_permits.json
#   { source, licence, generatedAt, from, to,
#     areas: { "<uid>": { units:{ sf, semi, apt, other }, lost, nonres } } }
# ---------------------------------------------------------------------------

suppressMessages({ library(sf); library(jsonlite) })
sf_use_s2(FALSE)

this_dir <- tryCatch(dirname(sub("^--file=", "",
             grep("^--file=", commandArgs(FALSE), value = TRUE)[1])), error = function(e) ".")
if (is.na(this_dir) || !nzchar(this_dir)) this_dir <- "r"
repo_root <- normalizePath(file.path(this_dir, ".."), mustWork = FALSE)
cache_dir <- file.path(repo_root, "r", "lib", "cache", "geo")
geo_dir   <- file.path(repo_root, "web", "public", "data", "geo")
dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)

CRS_M         <- 26914
WINDOW_MONTHS <- 60

# Permit sub_type → narrative building type.
TYPE <- c("SFD" = "sf", "SFD & Att. Gar." = "sf",
          "Duplex / Side by Side" = "semi", "Row Housing" = "semi",
          "Apartments" = "apt", "Residential Multi-Use" = "apt", "Commercial Multi-tenant" = "apt")

cached <- function(name, url, min_bytes = 1e4) {
  f <- file.path(cache_dir, name)
  if (!file.exists(f) || file.size(f) < min_bytes) {
    message("[32] Downloading ", name, "…")
    download.file(url, f, mode = "wb", quiet = TRUE)
  }
  f
}

# --- Polygons (same sources as r/29–31) ----------------------------------------
nb <- st_read(cached("wpg_neighbourhoods.geojson",
  "https://data.winnipeg.ca/resource/8k6x-xxsy.geojson?$limit=1000"), quiet = TRUE)
nb <- data.frame(uid = paste0("WPG_NB:", nb$name), geometry = st_geometry(nb)) |> st_as_sf()
cb <- st_read(cached("wpg_census_boundaries_2016.geojson",
  paste0("https://data.winnipeg.ca/resource/re9d-6c9j.geojson?$limit=1000&$where=",
         URLencode("year=2016 AND boundary_type in('Neighbourhood Cluster','CCA')", reserved = TRUE))), quiet = TRUE)
cb <- data.frame(uid = paste0(ifelse(cb$boundary_type == "CCA", "WPG_CA:", "WPG_CL:"), gsub(" - ", "-", cb$boundary_name)),
                 geometry = st_geometry(cb)) |> st_as_sf()
areas <- st_transform(st_make_valid(rbind(nb, cb)), CRS_M)

# --- Permits -----------------------------------------------------------------------
since <- format(seq(Sys.Date(), by = paste0("-", WINDOW_MONTHS + 3, " months"), length.out = 2)[2])
pm <- read.csv(cached("wpg_permits_recent.csv", paste0(
  "https://data.winnipeg.ca/resource/it4w-cpf4.csv?$limit=200000&$select=issue_date,permit_group,sub_type,work_type,dwelling_units_created,dwelling_units_lost,x_coordinate_nad83,y_coordinate_nad83&$where=",
  URLencode(paste0("issue_date >= '", since, "' AND x_coordinate_nad83 IS NOT NULL"), reserved = TRUE)), 1e5),
  stringsAsFactors = FALSE)
pm$issue_date <- as.Date(substr(pm$issue_date, 1, 10))
to   <- max(pm$issue_date)
from <- seq(to, by = paste0("-", WINDOW_MONTHS, " months"), length.out = 2)[2] + 1
pm <- pm[pm$issue_date >= from, ]
for (k in c("dwelling_units_created", "dwelling_units_lost")) pm[[k]][is.na(pm[[k]])] <- 0
# Units lost only from demolitions and changes of use — renovation permits on
# apartment blocks sometimes record units "lost" that come back afterwards.
pm$dwelling_units_lost[!pm$work_type %in% c("Demolish", "Change of Use")] <- 0
pm$type <- unname(TYPE[pm$sub_type]); pm$type[is.na(pm$type)] <- "other"
pm$nonres <- pm$permit_group == "Non-Residential" & pm$work_type == "Construct New"
pm <- pm[pm$dwelling_units_created > 0 | pm$dwelling_units_lost > 0 | pm$nonres, ]
# NAD83 / UTM 14N, the same CRS as the areas.
pts <- st_as_sf(pm, coords = c("x_coordinate_nad83", "y_coordinate_nad83"), crs = CRS_M)
message("[32] ", nrow(pm), " relevant permits, ", from, " to ", to)

hit <- st_intersects(areas, pts)
out <- list()
for (a in seq_len(nrow(areas))) {
  p <- pm[hit[[a]], ]
  u <- vapply(c("sf", "semi", "apt", "other"), function(t) sum(p$dwelling_units_created[p$type == t]), 0)
  out[[areas$uid[a]]] <- list(units = as.list(u), lost = sum(p$dwelling_units_lost), nonres = sum(p$nonres))
}

res <- list(
  source = "City of Winnipeg Open Data (Detailed Building Permit Data it4w-cpf4, Neighbourhoods 8k6x-xxsy, Census Boundaries re9d-6c9j)",
  licence = "Open Government Licence – Winnipeg",
  generatedAt = format(Sys.Date()), from = format(from), to = format(to),
  areas = out[order(names(out), method = "radix")])
f <- file.path(geo_dir, "wpg_nbhd_permits.json")
writeLines(toJSON(res, auto_unbox = TRUE, null = "null", digits = NA), f, useBytes = TRUE)
message("[32] wrote ", f, " (", round(file.size(f) / 1024), " KB, ", length(out), " areas)")
