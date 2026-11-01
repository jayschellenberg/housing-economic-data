#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# 30_build_wpg_nbhd_landuse.R — land use (from current zoning) for each
# Winnipeg neighbourhood / cluster / community area, for the Census Profile
# tab's community-profile narrative (Phase 3, Winnipeg mode, slice 2):
#
#   "Based on current zoning, Daniel McIntyre is predominantly low-density
#    residential. Commercial uses are concentrated along Sargent Avenue,
#    Notre Dame Avenue and Sherbrook Street, while the interior blocks are
#    predominantly residential."
#
# Sources:
#   * City of Winnipeg Open Data (Open Government Licence – Winnipeg):
#       Zoning By-law Parcels (Socrata dxrp-w6re) — ~18.5k zoned polygons,
#         current state (map_colour = the zoning category);
#       Neighbourhoods (8k6x-xxsy) + Census Boundaries (re9d-6c9j, 2016);
#       Road Network (ngsx-caav).
#   * r/lib/wpg_arterials.csv — the curated major-street list r/29 uses.
#
# Method (metres, EPSG:26914):
#   Shares — zoning polygons clipped to the area; share of zoned land by
#     category (roads and rail are unzoned, so they don't dilute it).
#   Commercial corridors — each curated arterial within STREET_M of the area
#     is clipped to the area (+ STREET_M) and sampled every SAMPLE_M; a sample
#     is commercial when commercially zoned land INSIDE the area lies within
#     FRONT_M. A corridor = at least MIN_LEN_M of street with ≥ CORRIDOR_SHARE
#     of its samples commercial. So a boundary street counts only for the
#     commercial frontage on this area's side.
#
# RUN-ONCE / MANUAL (needs sf; downloads cached under r/lib/cache/geo/):
#   Rscript r/30_build_wpg_nbhd_landuse.R
#
# Output: web/public/data/geo/wpg_nbhd_landuse.json
#   { source, licence, generatedAt,
#     areas: { "<uid>": { shares:{ <category>: 0..1 }, corridors:[{name, share}] } } }
#   Categories: sf two mf rr com ind park inst ag dt (downtown sectors).
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

CRS_M          <- 26914
STREET_M       <- 40
SAMPLE_M       <- 25
FRONT_M        <- 50
MIN_LEN_M      <- 400    # shorter = a corner clip (Broadway at Wolseley, 380 m)
CORRIDOR_SHARE <- 0.35

cached <- function(name, url, min_bytes = 1e4) {
  f <- file.path(cache_dir, name)
  if (!file.exists(f) || file.size(f) < min_bytes) {
    message("[30] Downloading ", name, "…")
    download.file(url, f, mode = "wb", quiet = TRUE)
  }
  f
}

# Zoning category (the City's map_colour) → short key.
CAT <- c("Single Family Residential" = "sf", "Two Family Residential" = "two",
         "Multi-Family Residential" = "mf", "Rural Residential" = "rr",
         "Commercial" = "com", "Industrial" = "ind", "Parks and Recreation" = "park",
         "Educational & Institutional" = "inst", "Agricultural" = "ag",
         "Character Sector" = "dt", "Downtown Living Sector" = "dt",
         "Multi-Use Sector" = "dt", "Riverbank Sector" = "dt")

# --- Polygons (same sources as r/29) ---------------------------------------
nb <- st_read(cached("wpg_neighbourhoods.geojson",
  "https://data.winnipeg.ca/resource/8k6x-xxsy.geojson?$limit=1000"), quiet = TRUE)
nb <- data.frame(uid = paste0("WPG_NB:", nb$name), geometry = st_geometry(nb)) |> st_as_sf()
cb <- st_read(cached("wpg_census_boundaries_2016.geojson",
  paste0("https://data.winnipeg.ca/resource/re9d-6c9j.geojson?$limit=1000&$where=",
         URLencode("year=2016 AND boundary_type in('Neighbourhood Cluster','CCA')", reserved = TRUE))), quiet = TRUE)
cb <- data.frame(uid = paste0(ifelse(cb$boundary_type == "CCA", "WPG_CA:", "WPG_CL:"), gsub(" - ", "-", cb$boundary_name)),
                 geometry = st_geometry(cb)) |> st_as_sf()
areas <- st_transform(st_make_valid(rbind(nb, cb)), CRS_M)

# --- Zoning ------------------------------------------------------------------
zon <- st_read(cached("wpg_zoning.geojson",
  "https://data.winnipeg.ca/resource/dxrp-w6re.geojson?$limit=50000", 1e6), quiet = TRUE)
zon$cat <- unname(CAT[zon$map_colour])
if (any(is.na(zon$cat))) message("[30] unmapped zoning categories: ",
  paste(unique(zon$map_colour[is.na(zon$cat)]), collapse = ", "))
zon <- st_transform(st_make_valid(zon[!is.na(zon$cat), "cat"]), CRS_M)
message("[30] ", nrow(zon), " zoning polygons, ", nrow(areas), " areas")

# --- Arterials (as r/29) -------------------------------------------------------
rd <- st_read(cached("wpg_road_network.geojson",
  "https://data.winnipeg.ca/resource/ngsx-caav.geojson?$limit=50000", 1e6), quiet = TRUE)
rd <- st_transform(rd[!is.na(rd$st_name) & rd$type == "STREET", "full_name"], CRS_M)
art_csv <- read.csv(file.path(repo_root, "r", "lib", "wpg_arterials.csv"), stringsAsFactors = FALSE)
arts <- do.call(rbind, lapply(seq_len(nrow(art_csv)), function(i) {
  seg <- rd[rd$full_name %in% strsplit(art_csv$full_names[i], ";", fixed = TRUE)[[1]], ]
  if (!nrow(seg)) return(NULL)
  st_sf(label = art_csv$label[i], geometry = st_union(st_geometry(seg)))
}))

# --- Per area -------------------------------------------------------------------
cand <- st_intersects(areas, zon)
out <- list()
for (a in seq_len(nrow(areas))) {
  poly <- st_geometry(areas[a, ])
  z <- suppressWarnings(st_intersection(zon[cand[[a]], ], poly))
  z <- z[st_dimension(z) == 2, ]
  ar <- as.numeric(st_area(z))
  tot <- sum(ar)
  shares <- if (tot > 0) as.list(round(tapply(ar, z$cat, sum) / tot, 3)) else list()

  corridors <- list()
  com <- z[z$cat == "com", ]
  if (nrow(com)) {
    zone_buf <- st_buffer(poly, STREET_M)
    for (k in which(lengths(st_intersects(arts, zone_buf)) > 0)) {
      seg <- suppressWarnings(st_intersection(st_geometry(arts[k, ]), zone_buf))
      seg <- seg[st_dimension(seg) == 1]
      len <- sum(as.numeric(st_length(seg)))
      if (len < MIN_LEN_M) next
      pts <- st_cast(st_line_sample(st_cast(seg, "LINESTRING"), density = 1 / SAMPLE_M), "POINT")
      if (!length(pts)) next
      hit <- lengths(st_is_within_distance(pts, com, FRONT_M)) > 0
      if (mean(hit) >= CORRIDOR_SHARE)
        corridors[[length(corridors) + 1]] <- list(name = arts$label[k], share = round(mean(hit), 2), m = round(len))
    }
    # Longest commercial frontage first.
    if (length(corridors)) corridors <- corridors[order(-vapply(corridors, function(x) x$share * x$m, 0))]
  }
  out[[areas$uid[a]]] <- list(shares = shares, corridors = corridors)
  if (a %% 25 == 0) message("  ", a, "/", nrow(areas))
}

res <- list(
  source = "City of Winnipeg Open Data (Zoning By-law Parcels dxrp-w6re, Neighbourhoods 8k6x-xxsy, Census Boundaries re9d-6c9j, Road Network ngsx-caav); curated arterial list r/lib/wpg_arterials.csv",
  licence = "Open Government Licence – Winnipeg",
  generatedAt = format(Sys.Date()),
  areas = out[order(names(out), method = "radix")])
f <- file.path(geo_dir, "wpg_nbhd_landuse.json")
writeLines(toJSON(res, auto_unbox = TRUE, null = "null", digits = NA), f, useBytes = TRUE)
message("[30] wrote ", f, " (", round(file.size(f) / 1024), " KB, ", length(out), " areas)")
