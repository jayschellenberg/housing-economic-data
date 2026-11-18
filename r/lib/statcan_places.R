# 2021 Census population and dwelling counts for Manitoba's designated places
# (98-10-0012) and population centres (98-10-0011). Used by r/27 (ranking a
# municipality's main town) and r/33 (community growth + seasonal dwellings).
#
# Read cell by cell through the WDS coordinate API (r/lib/statcan_wds.R, which
# the caller must source first): StatsCan has blocked programmatic full-table
# downloads since 2026-11. The result is cached as
# <cache_dir>/statcan_mb_places_2021.csv; delete it to refresh.
#
# Designated-place codes carry the province code (46…, plus Manitoba itself as
# "46"); population-centre codes do not, so those are kept by their place in
# the table's member list, which nests them under the Manitoba member.

mb_place_populations <- function(cache_dir, user_agent = "housing-economic-data") {
  cache <- file.path(cache_dir, "statcan_mb_places_2021.csv")
  if (file.exists(cache))
    return(read.csv(cache, check.names = FALSE, stringsAsFactors = FALSE, encoding = "UTF-8"))
  if (!exists("wds_fetch_coords", mode = "function"))
    stop("mb_place_populations() needs r/lib/statcan_wds.R sourced first")

  # Measure name pattern -> output column (dimension 2 of both tables).
  measures <- c(pop21 = "Population, 2021", pop16 = "Population, 2016", dwell = "Total private dwellings",
                occ = "occupied by usual residents", area = "Land area")
  one <- function(pid) {
    meta <- wds_cube_metadata(pid)
    geo <- wds_members(meta, 1)
    if (pid == 98100012L) {
      geo <- geo[!is.na(geo$code) & grepl("^46", geo$code), ]
    } else {
      # Member ids strictly between Manitoba and the next province in the list.
      prov <- geo[!is.na(geo$code) & geo$code %in% as.character(c(10, 11, 12, 13, 24, 35, 46, 47, 48, 59, 60, 61, 62)), ]
      lo <- prov$memberId[prov$code == "46"]
      hi <- min(prov$memberId[prov$memberId > lo])
      geo <- geo[geo$memberId > lo & geo$memberId < hi, ]
    }
    if (!nrow(geo)) stop(sprintf("[places] no Manitoba members found in table %s", pid))
    ms <- wds_members(meta, 2)
    mid <- vapply(measures, function(p) {
      hit <- ms$memberId[grepl(p, ms$name, fixed = TRUE)]
      if (!length(hit)) stop(sprintf("[places] no measure matching '%s' in table %s", p, pid))
      hit[1]
    }, integer(1))
    req <- merge(data.frame(geo = geo$memberId), data.frame(col = names(mid), m = unname(mid)), by = NULL)
    req$coordinate <- wds_coordinate(req$geo, req$m)
    got <- wds_fetch_coords(pid, req$coordinate, latest_n = 1L, tag = "places")
    req$value <- got$value[match(req$coordinate, got$coordinate)]
    val <- function(col) req$value[req$col == col][match(geo$memberId, req$geo[req$col == col])]
    data.frame(geo = sub(" \\((Manitoba part|Saskatchewan part)\\)$", "", geo$name), pop21 = val("pop21"),
               pop16 = val("pop16"), dwell = val("dwell"), occ = val("occ"), area = val("area"),
               kind = if (pid == 98100012L) "designated place" else "population centre",
               stringsAsFactors = FALSE)
  }
  out <- rbind(one(98100012L), one(98100011L))
  dir.create(cache_dir, showWarnings = FALSE, recursive = TRUE)
  write.csv(out, cache, row.names = FALSE, fileEncoding = "UTF-8")
  out
}
