# wrreb_monthly.ps1 - monthly WRREB market-release scrape (Task Scheduler entry point).
#
# Runs r\16b_scrape_wrreb.R, which reads the latest Winnipeg Regional Real Estate Board
# market release and writes the figures to
#   <Dropbox>\SharedInfo\AppMarketData\AppMarketData-Internal\WRREBMarket\wrreb_market.json
# for the MB Economic Update tab's Local Data store. Internal only: WRREB's terms forbid
# publishing the figures, so this runs on Jason's PC, never in GitHub Actions.
#
# A failed run, a stale result (scrape fell back to last-good) or a release month that has
# not advanced (expected: last month's release by the run day) sends a failure alert
# (email + ntfy) through the shared mb-parcelsearch alert-lib.ps1.
# Log: logs\wrreb-<stamp>.log ; ends with COMPLETE on success.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\wrreb_monthly.ps1
#   ... -TestAlert   (send one test alert and stop)
param([switch]$TestAlert)

$ErrorActionPreference = 'Stop'
$repo    = Split-Path $PSScriptRoot -Parent                    # housing-economic-data
$dropbox = Split-Path (Split-Path $repo -Parent) -Parent       # Dropbox root (no drive letter)
$mbps    = Join-Path $dropbox 'ClaudeCode\MBOpenData\mb-parcelsearch'
$topic   = 'hed-wrreb-monthly-jks'
$out     = Join-Path $dropbox 'SharedInfo\AppMarketData\AppMarketData-Internal\WRREBMarket\wrreb_market.json'
$stamp   = Get-Date -Format 'yyyyMMdd-HHmm'
$logDir  = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log     = Join-Path $logDir "wrreb-$stamp.log"
. (Join-Path $mbps 'alert-lib.ps1')

# Dropbox briefly locks a file it has just seen appear, so a log append can fail with
# "being used by another process". Retry for a few seconds rather than fail the run.
function Write-Log([string]$text) {
  for ($i = 0; $i -lt 20; $i++) {
    try { [IO.File]::AppendAllText($log, $text + [Environment]::NewLine, [Text.Encoding]::UTF8); return }
    catch { Start-Sleep -Milliseconds 250 }
  }
  Write-Warning "could not write to $log"
}

function Fail([string]$title, [string]$body) {
  Send-FailureAlert $mbps $topic $title "$body Log: $log" | Out-Null
  Write-Log "FAILED: $title"
  exit 1
}

if ($TestAlert) {
  $ok = Send-FailureAlert $mbps $topic 'WRREB monthly: test alert' 'Test from scripts\wrreb_monthly.ps1 -TestAlert.'
  if ($ok) { exit 0 } else { exit 1 }
}

function Invoke-Logged([string]$exe, [string[]]$argv) {
  $ErrorActionPreference = 'Continue'   # R's stderr must not become a terminating error
  & $exe @argv 2>&1 | ForEach-Object { $line = "$_"; Write-Host $line; Write-Log $line }
  return $LASTEXITCODE
}

$rscript = (Get-Command Rscript -ErrorAction Stop).Source
Push-Location $repo
try {
  $code = Invoke-Logged $rscript @('r/16b_scrape_wrreb.R')
} finally { Pop-Location }

if ($code -eq 2) { Fail 'WRREB scrape FAILED' 'r/16b could not read the latest release; the last-good figures were kept (stale).' }
if ($code -ne 0) { Fail 'WRREB scrape FAILED' "r/16b exit $code." }
if (-not (Test-Path $out)) { Fail 'WRREB scrape FAILED' "No output at $out." }

$j = Get-Content $out -Raw -Encoding UTF8 | ConvertFrom-Json
if ($j.stale -or $j.fetched -ne (Get-Date -Format 'yyyy-MM-dd')) {
  Fail 'WRREB scrape stale' "wrreb_market.json fetched $($j.fetched), stale=$($j.stale)."
}
# By the run day WRREB has normally posted last month's release.
$asOf = [datetime]::ParseExact("1 $($j.asOf)", 'd MMMM yyyy', [Globalization.CultureInfo]::InvariantCulture)
$want = (Get-Date -Day 1).Date.AddMonths(-1)
if ($asOf -lt $want) {
  Fail 'WRREB release not new' "Latest release read is $($j.asOf); expected $($want.ToString('MMMM yyyy')). WRREB may be late, or the listing page changed."
}
if ($j.comparisonsStale) { Write-Log 'note: some fields kept from an earlier month (comparisonsStale)' }

Write-Log "wrreb_market.json: $($j.asOf)"
Write-Log 'COMPLETE'
exit 0
