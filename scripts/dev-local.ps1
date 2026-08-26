# ---------------------------------------------------------------------------
# One command to run the whole product locally, with zero external accounts.
#
#   pnpm dev:local        (or:  powershell -File scripts/dev-local.ps1)
#
# Starts Postgres inside WSL if it is down, loads .env, makes sure the Prisma
# client exists, then runs API (:3001) + customer web (:3000) + admin (:3002).
# Ctrl-C stops everything.
#
# See docs/LOCAL-FIRST-BUILD.md for why this must work from a cold machine.
# ---------------------------------------------------------------------------
param(
    [switch]$SkipDb,      # don't touch WSL Postgres
    [switch]$NoServers    # set up only, don't run the dev servers
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($msg) { Write-Host "`n▸ $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }

# --- pnpm is not on PATH on this machine; corepack's shims are. ------------
$shims = "C:\Program Files\nodejs\node_modules\corepack\shims"
if (Test-Path $shims) { $env:PATH = "$shims;$env:PATH" }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm not found. Expected corepack shims at $shims"
}

# --- .env ------------------------------------------------------------------
Step "Loading .env"
if (-not (Test-Path .env)) { throw "Missing .env — copy .env.local.example to .env first." }
Get-Content .env | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    $v = $v.Trim() -replace '^"', '' -replace '"$', ''
    [Environment]::SetEnvironmentVariable($k.Trim(), $v, 'Process')
}
Ok "env loaded ($(if ($env:DATABASE_URL) { 'DATABASE_URL set' } else { 'DATABASE_URL MISSING' }))"

# --- Postgres (lives in WSL; Windows reaches it on 127.0.0.1:5432) ---------
if (-not $SkipDb) {
    Step "Starting Postgres (WSL Ubuntu)"
    wsl -d Ubuntu -- bash -lc "sudo pg_ctlcluster 18 main start 2>/dev/null; true" | Out-Null

    $deadline = (Get-Date).AddSeconds(30)
    $up = $false
    while ((Get-Date) -lt $deadline) {
        $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port 5432 -WarningAction SilentlyContinue -InformationLevel Quiet
        if ($probe) { $up = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $up) { throw "Postgres did not come up on 127.0.0.1:5432. Try: wsl -d Ubuntu -- bash -lc 'sudo pg_ctlcluster 18 main start'" }
    Ok "postgres listening on 127.0.0.1:5432"
}

# --- Prisma client ---------------------------------------------------------
Step "Checking Prisma client"
$generated = Get-ChildItem "node_modules\.pnpm" -Filter "@prisma+client@*" -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "node_modules\.prisma\client\index.js" } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $generated) {
    Warn "not generated — running pnpm db:generate"
    pnpm db:generate | Out-Null
}
Ok "prisma client ready"

# --- Schema present? -------------------------------------------------------
Step "Checking schema + seed"
$tables = (wsl -d Ubuntu -- bash -lc "sudo -u postgres psql -d marina -tAc `"select count(*) from information_schema.tables where table_schema='public'`" 2>/dev/null").Trim()
if (-not $tables -or [int]$tables -eq 0) {
    Warn "no tables — applying migrations + RLS"
    pnpm db:migrate; pnpm db:rls; pnpm db:approle; pnpm db:seed
    Ok "database provisioned and seeded"
} else {
    Ok "$tables tables present"
}

if ($NoServers) { Step "Setup complete (-NoServers)"; exit 0 }

# --- Run -------------------------------------------------------------------
Write-Host ""
Write-Host "  ┌────────────────────────────────────────────────────────┐" -ForegroundColor DarkGray
Write-Host "  │  Marina Booking Platform — local sandbox                │" -ForegroundColor DarkGray
Write-Host "  ├────────────────────────────────────────────────────────┤" -ForegroundColor DarkGray
Write-Host "  │  Customer site   http://localhost:3000                  │" -ForegroundColor White
Write-Host "  │  Admin console   http://localhost:3002                  │" -ForegroundColor White
Write-Host "  │  Local Console   http://localhost:3002/dev              │" -ForegroundColor White
Write-Host "  │  API             http://localhost:3001                  │" -ForegroundColor DarkGray
Write-Host "  └────────────────────────────────────────────────────────┘" -ForegroundColor DarkGray
Write-Host "     no accounts needed — payments, email and SMS are simulated" -ForegroundColor DarkGray
Write-Host "     Ctrl-C stops everything`n" -ForegroundColor DarkGray

pnpm dev
