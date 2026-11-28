# wrreb_monthly.ps1 - monthly internal market data scrape: WRREB market release, CREA MLS HPI and
# Yahoo Finance market returns (Task Scheduler entry point).
#
# Runs r\16b_scrape_wrreb.R, which reads the latest Winnipeg Regional Real Estate Board
# market release and writes the figures to
#   <Dropbox>\SharedInfo\AppMarketData\AppMarketData-Internal\WRREBMarket\wrreb_market.json
# for the MB Economic Update tab's Local Data store. Internal only: WRREB's terms forbid
# publishing the figures, so this runs on Jason's PC, never in GitHub Actions.
#
# Then runs r\16_scrape_mls.R, which reads CREA's MLS HPI workbook and writes
#   <Dropbox>\SharedInfo\AppMarketData\AppMarketData-Internal\CREAHPI\mls_benchmark.json
# for the Economic Update (HPI sentence, Figure 3) and Affordability tabs. Internal only too:
# CREA needs prior written consent to publish HPI values. A CREA failure or stale result sends
# its own alert ("CREA HPI scrape FAILED") and does not stop the WRREB checks.
#
# Then runs r\28b_scrape_market_returns.R, which reads the XIC.TO and ZFL.TO adjusted closes
# from Yahoo Finance and writes
#   <Dropbox>\SharedInfo\AppMarketData\AppMarketData-Internal\MarketReturns\market_returns.json
# for the Market Discount Rates tab's equity and bond lines. Internal only: Yahoo grants no
# licence to republish its prices. A failure or stale result sends its own alert too.
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
$creaOut = Join-Path $dropbox 'SharedInfo\AppMarketData\AppMarketData-Internal\CREAHPI\mls_benchmark.json'
$retOut  = Join-Path $dropbox 'SharedInfo\AppMarketData\AppMarketData-Internal\MarketReturns\market_returns.json'
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
  $creaCode = Invoke-Logged $rscript @('r/16_scrape_mls.R')
  $retCode  = Invoke-Logged $rscript @('r/28b_scrape_market_returns.R')
} finally { Pop-Location }

# CREA HPI: alert without exiting, so the WRREB checks below still run. CREA posts each
# release around the middle of the month, so by the 12th the newest data month can be the
# month before last; only a failure, a stale result or older data is flagged.
function Test-Crea {
  if ($creaCode -eq 2) { return 'r/16 could not read the latest CREA HPI workbook; the last-good file was kept (stale).' }
  if ($creaCode -ne 0) { return "r/16 exit $creaCode." }
  if (-not (Test-Path $creaOut)) { return "No output at $creaOut." }
  $c = Get-Content $creaOut -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($c.stale -or $c.fetched -ne (Get-Date -Format 'yyyy-MM-dd')) { return "mls_benchmark.json fetched $($c.fetched), stale=$($c.stale)." }
  $cAsOf = [datetime]::ParseExact("1 $($c.asOf)", 'd MMMM yyyy', [Globalization.CultureInfo]::InvariantCulture)
  $cWant = (Get-Date -Day 1).Date.AddMonths(-2)
  if ($cAsOf -lt $cWant) { return "Latest CREA HPI month is $($c.asOf); expected $($cWant.ToString('MMMM yyyy')) or later." }
  Write-Log "mls_benchmark.json: $($c.asOf)"
  return $null
}
$creaProblem = Test-Crea
if ($creaProblem) {
  Send-FailureAlert $mbps $topic 'CREA HPI scrape FAILED' "$creaProblem Log: $log" | Out-Null
  Write-Log "FAILED: CREA HPI: $creaProblem"
}

# Market returns (Yahoo): same pattern. Daily prices should reach within a week of the run.
function Test-Returns {
  if ($retCode -eq 2) { return 'r/28b could not fetch XIC or ZFL from Yahoo Finance; the last-good series were kept (stale).' }
  if ($retCode -ne 0) { return "r/28b exit $retCode." }
  if (-not (Test-Path $retOut)) { return "No output at $retOut." }
  $r = Get-Content $retOut -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($r.stale -or $r.built -ne (Get-Date -Format 'yyyy-MM-dd')) { return "market_returns.json built $($r.built), stale=$($r.stale)." }
  $lastDates = @($r.series | ForEach-Object { $_.dates[-1] } | Sort-Object)
  if (-not $lastDates.Count -or [datetime]$lastDates[0] -lt (Get-Date).Date.AddDays(-7)) { return "Oldest series ends $($lastDates[0]); expected within the last week." }
  Write-Log "market_returns.json: to $($lastDates[0])"
  return $null
}
$retProblem = Test-Returns
if ($retProblem) {
  Send-FailureAlert $mbps $topic 'Market returns scrape FAILED' "$retProblem Log: $log" | Out-Null
  Write-Log "FAILED: market returns: $retProblem"
}

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
if ($creaProblem -or $retProblem) { exit 1 }
Write-Log 'COMPLETE'
exit 0
