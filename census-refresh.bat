@echo off
REM Census / dwelling-data refresh — the 5-yearly companion to
REM monthly-refresh.bat. The monthly pipeline (data:all) deliberately SKIPS the
REM census-derived datasets because they only change when Statistics Canada
REM releases a new census. Run this by hand after a census release
REM (2021 data is current; next census 2026, published ~2027-2028).
REM
REM Rebuilds, then commits + pushes web/public/data so Vercel redeploys:
REM   - Housing Stock  : census_housing.json  (age + condition, r/07-09)   [StatsCan WDS, no key]
REM   - Dwelling type  : dwelling_types.json  (structural type, r/10+10b/c/d) [StatsCan WDS, no key]
REM   - Census Profile : census_profile.json  (r/12)                         [CensusMapper key]
REM   - WPG cluster/CA history : census_profile.json  (r/12b, appends 2006-2016)  [no key — City of Winnipeg downloads]

setlocal
cd /d "%~dp0"

REM --- StatsCan WDS census data (no API key needed) ---------------------------
REM Order matters: r/07 and r/10 create the 2021 base files; the others append
REM earlier census years, so they must run after their base.
Rscript r/07_scrape_census_housing.R || goto :err
Rscript r/08_add_census_2011.R        || goto :err
Rscript r/09_add_census_2006.R        || goto :err
Rscript r/10_dwelling_types.R         || goto :err
Rscript r/10b_dwelling_types_2016.R   || goto :err
Rscript r/10c_dwelling_types_2011.R   || goto :err
Rscript r/10d_dwelling_types_2006.R   || goto :err

REM --- Census Profile tab (CensusMapper / cancensus — needs CM_API_KEY) -------
REM Best-effort: r/12 still writes all standard Manitoba levels and only skips
REM the Winnipeg DA geos if the daily/monthly quota is exhausted (it's resumable
REM across days), and stops with a clear message if no key is configured. So we
REM do NOT abort the whole refresh on its exit code.
Rscript r/12_census_profile.R
if errorlevel 1 echo [census-refresh] Census Profile (r/12) did not fully complete - set CM_API_KEY and/or re-run later (quota). Other census data still refreshed.

REM --- Labour force by industry (NAICS sectors, 2021 + 2016; needs CM_API_KEY) -
REM Feeds the Census Profile narrative's "Employment by industry" paragraph.
REM Standard levels only; add CENSUS_INDUSTRY_WPG=1 to also aggregate the
REM Winnipeg neighbourhoods from DAs (costs ~1,130 regions of daily quota).
Rscript r/26_census_industry.R
if errorlevel 1 echo [census-refresh] Labour force by industry (r/26) did not complete - set CM_API_KEY and/or re-run later (quota).

REM --- WPG cluster/CA history (City of Winnipeg downloads, no key) ------------
REM Appends 2006/2011/2016 trends + 2011/2016 demographics to the Winnipeg
REM clusters/CAs that r/12 writes for 2021. Best-effort; downloads are cached.
Rscript r/12b_wpg_city_history.R
if errorlevel 1 echo [census-refresh] WPG cluster/CA history (r/12b) did not complete - re-run later.

REM --- Commit + push if anything changed -------------------------------------
git diff --quiet web/public/data
if errorlevel 1 (
  git add web/public/data
  git commit -m "data: census refresh"
  git push
) else (
  echo No data changes.
)
exit /b 0

:err
echo Census pipeline failed; aborting.
exit /b 1
