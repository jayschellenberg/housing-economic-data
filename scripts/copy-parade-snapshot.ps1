# Copy the Parade of Homes analysis snapshot into web/public/parade/.
#
# Run this after re-running Parade-Of-Homes/run_pipeline.sh (or
# analyze_parade.R) in the Parade-Of-Homes project, so the "Parade of
# Homes" tab on housing-economic-data picks up the newest issue.
#
# Usage (from this repo root):
#   pwsh scripts/copy-parade-snapshot.ps1
#
# Override the Parade source folder with -ParadeDir if it lives elsewhere.

param(
    [string]$ParadeDir = 'D:\Dropbox\ClaudeCode\$Projects in Progress\Parade-Of-Homes'
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Dst  = Join-Path $Repo 'web\public\parade'

$Scopes = @('winnipeg_nominal', 'winnipeg_real', 'all_nominal', 'all_real')

$Flat = @('price_trends.csv', 'size_trends.csv', 'style_mix.csv', 'keyword_trends.csv', 'builder_activity.csv', 'feature_trends.csv')
$Appraiser = @(
    'psf_by_style_year.csv',
    'size_by_style_year.csv',
    'upgrade_by_year.csv',
    'garage_mix.csv',
    'index_comparison.csv',
    'lot_trends.csv',
    'neighbourhood_comparison.csv',
    'builder_positioning.csv'
)

foreach ($scope in $Scopes) {
    $src     = Join-Path $ParadeDir "analysis_output\$scope"
    $srcAppr = Join-Path $src        'appraiser'
    $dstDir  = Join-Path $Dst        $scope
    if (!(Test-Path $src)) {
        Write-Warning "Skipping $scope (not found at $src)"
        continue
    }
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    foreach ($f in $Flat)      { Copy-Item (Join-Path $src     $f) (Join-Path $dstDir $f) -Force }
    foreach ($f in $Appraiser) { Copy-Item (Join-Path $srcAppr $f) (Join-Path $dstDir $f) -Force }
    Write-Host "  copied $scope"
}

# Latest issue + build time, read from the Winnipeg nominal price_trends.csv.
$priceCsv = Join-Path $Dst 'winnipeg_nominal\price_trends.csv'
$latest = ''
if (Test-Path $priceCsv) {
    $lastLine = (Get-Content $priceCsv | Select-Object -Last 1).Trim()
    if ($lastLine) { $latest = ($lastLine -split ',')[2] }
}
$built = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$manifest = [ordered]@{
    built           = $built
    latestIssue     = $latest
    scopes          = @('winnipeg', 'all')
    bases           = @('nominal', 'real')
    files           = @(
        'price_trends.csv',
        'size_trends.csv',
        'psf_by_style_year.csv',
        'size_by_style_year.csv',
        'upgrade_by_year.csv',
        'garage_mix.csv',
        'index_comparison.csv',
        'style_mix.csv',
        'lot_trends.csv',
        'keyword_trends.csv',
        'builder_activity.csv',
        'neighbourhood_comparison.csv',
        'builder_positioning.csv',
        'feature_trends.csv'
    )
    source          = 'MHBA Parade of Homes magazine listings (2012-present); automated extraction with QA review.'
    disclosure      = 'Prices are listing-reported house-only prices (land excluded), shown excluding GST (net GST removed by estimate for 2012-2016 issues); they may vary by development charge and option inclusion. For market commentary only; not an appraisal or value opinion.'
    realDisclosure  = 'Real-dollar values use Statistics Canada annual average CPI, all-items (Table 18-10-0005-01), expressed in the latest CPI year available.'
}
$manifest | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $Dst 'MANIFEST.json')

Write-Host "Parade snapshot copied (latest: $latest, built $built)."
