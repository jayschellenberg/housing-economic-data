@echo off
REM Local convenience wrapper. Re-runs the R pipeline, regenerates JSON
REM shards, and (if anything changed) commits + pushes so Vercel redeploys.
REM Equivalent to running the .github/workflows/refresh-data.yml action by hand.

setlocal
cd /d "%~dp0"

call npm --prefix web run data:all || goto :err

REM Anything to commit?
git diff --quiet web/public/data
if errorlevel 1 (
  git add web/public/data
  git commit -m "data: monthly refresh"
  git push
) else (
  echo No data changes.
)
exit /b 0

:err
echo Pipeline failed; aborting.
exit /b 1
