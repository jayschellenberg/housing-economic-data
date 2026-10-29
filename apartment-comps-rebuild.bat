@echo off
REM Apartment Income & Expenses tab: rebuild apartment_comps.json from the
REM two workbooks in D:\Dropbox\Appraisal\Comparables (the comps database and
REM Apartment Docs Extract.xlsx) into SharedInfo\AppMarketData\ApartmentComps.
REM Run after editing either workbook; no AI, takes seconds. The tab picks the
REM new file up on its next visit (or "Reload folder").
REM
REM New PDFs in the Apartments-Multi-family folder are NOT read here: the
REM weekly Claude task does that, or ask Claude to "scan new apartment docs".

setlocal
cd /d "%~dp0"
python -I scripts\apartment_comps.py build || goto :err
echo.
echo Documents not yet extracted:
python -I scripts\apartment_comps.py scan --limit 10
pause
exit /b 0

:err
echo.
echo Rebuild failed. If a workbook is open in Excel, save it and try again.
pause
exit /b 1
