#!/usr/bin/env Rscript
# ---------------------------------------------------------------------------
# 31_build_wpg_nbhd_character.R — development-plan designation, housing
# vintage, schools and hospitals for each Winnipeg neighbourhood / cluster /
# community area, for the Census Profile tab's community-profile narrative
# (Phase 3, Winnipeg mode, slice 3):
#
#   "Under OurWinnipeg, Daniel McIntyre is a Mature Community … Most homes were
#    built between 1910 and 1950. Schools in the neighbourhood include …
#    The nearest hospital is Health Sciences Centre, about 2 km away."
#
# Sources:
#   * City of Winnipeg Open Data (Open Government Licence – Winnipeg):
#       OurWinnipeg / Complete Communities urban structure — Mature Community
#         (5guk-f7xw), Recent Community (pmhu-s9aj), New Community (xkjt-v43a),
#         Rural Agricultural (2h9x-q656), Employment Lands (a9rt-buw5), Airport
#         Area (3nva-2f66), Major Redevelopment Site (piz6-n3at), Regional Mixed
#         Use Centre (wv32-jdtk); Downtown Boundary (c26m-yeye);
#       Assessment Parcels (d4mq-wa44) — year built + dwelling units. The roll
#         records year built only for houses, duplexes, row housing and condos,
#         not rental apartment blocks, so the vintage is of that stock;
#       Neighbourhoods (8k6x-xxsy) + Census Boundaries (re9d-6c9j, 2016).
#   * OpenStreetMap (© OpenStreetMap contributors, ODbL) via Overpass —
#       amenity=school / amenity=hospital (hospitals kept to HOSPITALS below).
#
# Method (metres, EPSG:26914):
#   Structure — share of the area inside each layer; the narrative names the
#     predominant one. Sites / centres = named features covering ≥ SITE_SHARE
#     of themselves inside the area.
#   Vintage — dwelling-unit-weighted 25th / 50th / 75th percentile year built
#     of assessed residential parcels whose centroid falls in the area (at
#     least MIN_SITES distinct lots).
#   Schools / hospitals — OSM features whose centre falls in the area; plus the
#     nearest acute-care hospital (straight line from the area's interior point).
#
# RUN-ONCE / MANUAL (needs sf + curl; downloads cached under r/lib/cache/geo/):
#   Rscript r/31_build_wpg_nbhd_character.R
#
# Output: web/public/data/geo/wpg_nbhd_character.json
#   { source, licence, generatedAt,
#     areas: { "<uid>": { structure:{ <key>: 0..1 }, sites:[name], centres:[name],
#                         vintage:{ p25, p50, p75, units }, schools:[name],
#                         hospitals:[name], nearestHospital:{ name, km } } } }
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

CRS_M      <- 26914
SITE_SHARE <- 0.5
MIN_SITES  <- 20      # fewer distinct residential lots = no vintage sentence (a
                      # lone condo building would read as "built in 2024")
BBOX       <- "49.70,-97.40,50.03,-96.93"

# Hospitals worth naming (OSM tags a few clinics / care homes as hospitals too).
# acute = full hospital with an emergency department or urgent care.
HOSPITALS <- c("Health Sciences Centre" = TRUE, "Saint Boniface Hospital" = TRUE,
               "Grace Hospital" = TRUE, "Victoria General Hospital" = TRUE,
               "Concordia Hospital" = TRUE, "Seven Oaks General Hospital" = TRUE,
               "Misericordia Health Centre" = FALSE, "Deer Lodge Centre" = FALSE,
               "Riverview Health Centre" = FALSE)
HOSP_LABEL <- c("Saint Boniface Hospital" = "St. Boniface Hospital")

cached <- function(name, url, min_bytes = 1e4, post = NULL) {
  f <- file.path(cache_dir, name)
  if (!file.exists(f) || file.size(f) < min_bytes) {
    message("[31] Downloading ", name, "…")
    if (is.null(post)) download.file(url, f, mode = "wb", quiet = TRUE)
    else {
      # Overpass: try each public endpoint in turn; it rejects requests
      # without a user agent, and a multipart post hangs it.
      ok <- FALSE
      for (u in url) {
        h <- curl::new_handle(useragent = "housing-economic-data r/31", timeout = 300,
                              postfields = paste0("data=", URLencode(post, reserved = TRUE)))
        ok <- tryCatch({ curl::curl_download(u, f, handle = h); TRUE },
                       error = function(e) { message("  ", u, ": ", conditionMessage(e)); FALSE })
        if (ok && file.size(f) >= min_bytes) break
      }
      if (!ok) { unlink(f); stop("[31] Overpass download failed", call. = FALSE) }
    }
  }
  f
}
socrata <- function(id, min_bytes = 500) st_read(cached(paste0("wpg_", id, ".geojson"),
  paste0("https://data.winnipeg.ca/resource/", id, ".geojson?$limit=50000"), min_bytes), quiet = TRUE)

# --- Polygons (same sources as r/29 / r/30) ----------------------------------
nb <- st_read(cached("wpg_neighbourhoods.geojson",
  "https://data.winnipeg.ca/resource/8k6x-xxsy.geojson?$limit=1000"), quiet = TRUE)
nb <- data.frame(uid = paste0("WPG_NB:", nb$name), geometry = st_geometry(nb)) |> st_as_sf()
cb <- st_read(cached("wpg_census_boundaries_2016.geojson",
  paste0("https://data.winnipeg.ca/resource/re9d-6c9j.geojson?$limit=1000&$where=",
         URLencode("year=2016 AND boundary_type in('Neighbourhood Cluster','CCA')", reserved = TRUE))), quiet = TRUE)
cb <- data.frame(uid = paste0(ifelse(cb$boundary_type == "CCA", "WPG_CA:", "WPG_CL:"), gsub(" - ", "-", cb$boundary_name)),
                 geometry = st_geometry(cb)) |> st_as_sf()
areas <- st_transform(st_make_valid(rbind(nb, cb)), CRS_M)
area_m2 <- as.numeric(st_area(areas))

# --- Urban structure ------------------------------------------------------------
LAYERS <- c(downtown = "c26m-yeye", mature = "5guk-f7xw", recent = "pmhu-s9aj",
            new = "xkjt-v43a", rural = "2h9x-q656", employment = "a9rt-buw5",
            airport = "3nva-2f66")
structure <- lapply(LAYERS, function(id) {
  g <- st_union(st_transform(st_make_valid(socrata(id)), CRS_M))
  ov <- suppressWarnings(st_intersection(areas, g))
  s <- setNames(rep(0, nrow(areas)), areas$uid)
  s[ov$uid] <- as.numeric(st_area(ov)) / area_m2[match(ov$uid, areas$uid)]
  s
})
named_in <- function(id) {
  f <- st_transform(st_make_valid(socrata(id)), CRS_M)
  f <- f[!is.na(f$feature_name), ]
  fa <- as.numeric(st_area(f))
  ov <- suppressWarnings(st_intersection(f[, "feature_name"], areas[, "uid"]))
  ov <- ov[as.numeric(st_area(ov)) / fa[match(ov$feature_name, f$feature_name)] >= SITE_SHARE, ]
  split(ov$feature_name, ov$uid)
}
sites   <- named_in("piz6-n3at")
centres <- named_in("wv32-jdtk")

# --- Housing vintage (assessment roll) ------------------------------------------
asmt <- read.csv(cached("wpg_assessment_yearbuilt.csv", paste0(
  "https://data.winnipeg.ca/resource/d4mq-wa44.csv?$limit=400000&$select=year_built,dwelling_units,centroid_lat,centroid_lon&$where=",
  URLencode("year_built IS NOT NULL AND centroid_lat IS NOT NULL", reserved = TRUE)), 1e6))
asmt <- asmt[asmt$year_built >= 1850 & asmt$year_built <= as.integer(format(Sys.Date(), "%Y")), ]
asmt$dwelling_units[is.na(asmt$dwelling_units) | asmt$dwelling_units < 1] <- 1
pts <- st_transform(st_as_sf(asmt, coords = c("centroid_lon", "centroid_lat"), crs = 4326), CRS_M)
in_area <- st_intersects(areas, pts)
wq <- function(y, w, p) { o <- order(y); cw <- cumsum(w[o]) / sum(w); y[o][which(cw >= p)[1]] }
message("[31] ", nrow(asmt), " assessed parcels with year built")

# --- Schools + hospitals (OSM) ---------------------------------------------------
osm <- fromJSON(cached("wpg_osm_schools_hospitals.json",
  c("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"), 1e4,
  post = paste0('[out:json][timeout:120];(nwr["amenity"~"^(hospital|school)$"](', BBOX, '););out center tags;')),
  simplifyVector = FALSE)$elements
osm <- do.call(rbind, lapply(osm, function(e) {
  ll <- if (!is.null(e$center)) e$center else e
  if (is.null(e$tags$name) || is.null(ll$lat)) return(NULL)
  data.frame(amenity = e$tags$amenity, name = trimws(gsub(" ", " ", e$tags$name)), lon = ll$lon, lat = ll$lat)
}))
osm <- st_transform(st_as_sf(osm, coords = c("lon", "lat"), crs = 4326), CRS_M)
schools <- osm[osm$amenity == "school", ]
# One school mapped twice ("Laura Secord School" + "École Laura Secord School",
# "H.S Paul School" + "H.S. Paul school"): keep the fuller name.
schools$key <- gsub("^(école|ecole)|school$", "", gsub("[^[:alpha:]]", "", tolower(schools$name)))
schools <- schools[order(-nchar(schools$name)), ]
hosp <- osm[osm$amenity == "hospital" & osm$name %in% names(HOSPITALS), ]
hosp <- hosp[!duplicated(hosp$name), ]
hosp$label <- ifelse(hosp$name %in% names(HOSP_LABEL), HOSP_LABEL[hosp$name], hosp$name)
acute <- hosp[HOSPITALS[hosp$name], ]
message("[31] ", nrow(schools), " schools, ", nrow(hosp), " hospitals (", nrow(acute), " acute)")
sch_in  <- st_intersects(areas, schools)
hosp_in <- st_intersects(areas, hosp)
inner   <- st_point_on_surface(st_geometry(areas))
d_acute <- st_distance(inner, acute)

# --- Per area ---------------------------------------------------------------------
out <- list()
for (a in seq_len(nrow(areas))) {
  uid <- areas$uid[a]
  st <- vapply(structure, function(s) round(s[[uid]], 3), 0)
  e <- list(structure = as.list(st[st >= 0.01]))
  if (!is.null(sites[[uid]]))   e$sites   <- I(unique(sites[[uid]]))
  if (!is.null(centres[[uid]])) e$centres <- I(unique(centres[[uid]]))
  k <- in_area[[a]]
  u <- sum(asmt$dwelling_units[k])
  # Condo units each carry a roll entry on the same lot, so count lots.
  lots <- nrow(unique(asmt[k, c("centroid_lat", "centroid_lon")]))
  if (lots >= MIN_SITES) {
    y <- asmt$year_built[k]; w <- asmt$dwelling_units[k]
    e$vintage <- list(p25 = wq(y, w, 0.25), p50 = wq(y, w, 0.5), p75 = wq(y, w, 0.75), units = u)
  }
  if (length(sch_in[[a]]))  e$schools   <- I(sort(schools$name[sch_in[[a]]][!duplicated(schools$key[sch_in[[a]]])]))
  if (length(hosp_in[[a]])) e$hospitals <- I(unique(hosp$label[hosp_in[[a]]]))
  j <- which.min(d_acute[a, ])
  e$nearestHospital <- list(name = acute$label[j], km = round(as.numeric(d_acute[a, j]) / 1000, 1))
  out[[uid]] <- e
}

res <- list(
  source = "City of Winnipeg Open Data (OurWinnipeg urban structure layers, Downtown Boundary c26m-yeye, Assessment Parcels d4mq-wa44, Neighbourhoods 8k6x-xxsy, Census Boundaries re9d-6c9j); OpenStreetMap schools + hospitals (© OpenStreetMap contributors, ODbL)",
  licence = "Open Government Licence – Winnipeg; ODbL (OpenStreetMap)",
  generatedAt = format(Sys.Date()),
  areas = out[order(names(out), method = "radix")])
f <- file.path(geo_dir, "wpg_nbhd_character.json")
writeLines(toJSON(res, auto_unbox = TRUE, null = "null", digits = NA), f, useBytes = TRUE)
message("[31] wrote ", f, " (", round(file.size(f) / 1024), " KB, ", length(out), " areas)")
