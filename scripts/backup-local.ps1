# ---------------------------------------------------------------------------
# Back up the LOCAL marina database (docs/LOCAL-FIRST-BUILD.md section 9).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-local.ps1
#
# Postgres lives in WSL Ubuntu (cluster 18); Windows reaches it on
# 127.0.0.1:5432. Everything here runs pg_dump INSIDE WSL and copies the file
# out, because the Windows side has no Postgres client binaries.
#
# Produces three files per run, in the backup directory:
#   marina-<stamp>.dump       custom-format pg_dump (schema + data + RLS policies + grants)
#   marina-<stamp>.roles.sql  cluster roles, so a rebuilt cluster can take the dump
#   marina-<stamp>.info.txt   what was in the database at dump time
#
# The .info.txt is not decoration - restore-local.ps1 compares against it, and a
# restore you did not verify is not a restore.
#
# SECRETS: the .roles.sql contains role password hashes. Keep the backup
# directory out of the repo and off shared drives. The default location is
# %USERPROFILE%\marina-backups for exactly that reason.
#
# NOTE ON QUOTING: SQL is written to a file and run with `psql -f`. Piping SQL
# text through PowerShell -> wsl -> bash -> psql is a quoting trap and has
# already broken once in this repo. Do not "simplify" it back.
# ---------------------------------------------------------------------------
param(
    [string]$Path,                  # backup directory (default %USERPROFILE%\marina-backups)
    [string]$Database = 'marina',
    [string]$Distro   = 'Ubuntu',
    [int]$ClusterVersion = 18,
    [int]$Keep = 10,                # backups to retain; 0 keeps everything
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Say($msg)  { if (-not $Quiet) { Write-Host "`n> $msg" -ForegroundColor Cyan } }
function Ok($msg)   { if (-not $Quiet) { Write-Host "  $msg" -ForegroundColor Green } }
function Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }

# --- helpers ---------------------------------------------------------------
# These are duplicated in restore-local.ps1 on purpose: each script has to be
# runnable on its own, including from a rescue copy on a USB stick, with no
# sibling module to dot-source.

# C:\Users\me\x -> /mnt/c/Users/me/x   (local drives only)
function ConvertTo-WslPath([string]$WinPath) {
    $full = [System.IO.Path]::GetFullPath($WinPath)
    if ($full -notmatch '^[A-Za-z]:\\') {
        throw "Only local drive paths work from WSL. Got: $full"
    }
    $drive = $full.Substring(0, 1).ToLower()
    $rest  = $full.Substring(2).Replace('\', '/')
    return "/mnt/$drive$rest"
}

# Every path is interpolated into a single-quoted bash string, so a quote in the
# path would break out of it. Refuse rather than build a broken command.
function Assert-SafePath([string]$p) {
    if ($p -match "['`"]") { throw "Path contains a quote character, which cannot be passed to WSL safely: $p" }
    return $p
}

# Run one command inside WSL. Returns exit code + combined output; throws on a
# non-zero exit unless -AllowFail. ErrorActionPreference is relaxed around the
# call because a native command writing to stderr becomes a terminating error
# under 'Stop' in Windows PowerShell 5.1.
function Invoke-Wsl {
    param([string]$Command, [switch]$AllowFail)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = (& wsl -d $Distro -- bash -lc $Command 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0 -and -not $AllowFail) {
        throw "WSL command failed (exit $code):`n  $Command`n$output"
    }
    return [pscustomobject]@{ ExitCode = $code; Output = $output.TrimEnd() }
}

# psql and pg_dump refuse to read a file they have no permission on, and the
# postgres system user cannot always read /mnt/c. Stage through /tmp instead.
function Copy-IntoWsl([string]$WinPath, [string]$WslPath) {
    $src = ConvertTo-WslPath (Assert-SafePath $WinPath)
    Invoke-Wsl "cp '$src' '$WslPath' && chmod 644 '$WslPath'" | Out-Null
}

function Copy-OutOfWsl([string]$WslPath, [string]$WinPath) {
    $dest = ConvertTo-WslPath (Assert-SafePath $WinPath)
    Invoke-Wsl "chmod 644 '$WslPath' 2>/dev/null || sudo chmod 644 '$WslPath'; cp '$WslPath' '$dest'" | Out-Null
}

# Write SQL as UTF-8 with NO BOM and LF endings. psql does not strip a BOM - it
# tries to execute it - and CRLF inside a dollar-quoted block confuses it.
function Write-SqlFile([string]$WinPath, [string]$Sql) {
    $text = ($Sql -replace "`r`n", "`n")
    [System.IO.File]::WriteAllText($WinPath, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-Identifier([string]$name, [string]$what) {
    # -cnotmatch, not -notmatch: PowerShell's default matching is case-INSENSITIVE,
    # which would let 'Marina' through a guard that exists to bound what gets
    # interpolated into SQL.
    if ($name -cnotmatch '^[a-z_][a-z0-9_]*$') {
        throw "$what must be a plain lower-case identifier (letters, digits, underscore). Got: $name"
    }
    return $name
}

# The one read-only query both scripts use to describe a database. Exact row
# counts via query_to_xml so no table name is hard-coded - a renamed model can
# never make this silently report nothing.
function Get-StatsSql {
@"
SELECT 'database', current_database();
SELECT 'postgres_version', current_setting('server_version');
SELECT 'tables', count(*)::text FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
SELECT 'rls_tables', count(*)::text FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relrowsecurity;
SELECT 'rls_policies', count(*)::text FROM pg_policies WHERE schemaname = 'public';
SELECT 'migrations_applied', count(*)::text FROM _prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'total_rows', COALESCE(sum(n), 0)::text FROM (
  SELECT (xpath('/row/c/text()',
           query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, relname),
                        false, true, '')))[1]::text::bigint AS n
  FROM pg_stat_user_tables WHERE schemaname = 'public'
) s;
SELECT 'rows.' || relname,
       (xpath('/row/c/text()',
         query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, relname),
                      false, true, '')))[1]::text
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND relname IN ('Operator','Customer','Order','Payment','Activity','AuditLog')
ORDER BY 1;
"@
}

# Read the database's shape. Returns the raw 'key|value' lines.
function Get-DbStats([string]$db, [string]$stamp) {
    $sqlWin = Join-Path $env:TEMP "marina-stats-$stamp.sql"
    $sqlWsl = "/tmp/marina-stats-$stamp.sql"
    Write-SqlFile $sqlWin (Get-StatsSql)
    try {
        Copy-IntoWsl $sqlWin $sqlWsl
        $res = Invoke-Wsl "sudo -u postgres psql -tA --no-password -v ON_ERROR_STOP=1 -d '$db' -f '$sqlWsl'" -AllowFail
        Invoke-Wsl "rm -f '$sqlWsl'" -AllowFail | Out-Null
        if ($res.ExitCode -ne 0) { return $null }
        return ($res.Output -split "`n" | Where-Object { $_ -match '\|' })
    } finally {
        Remove-Item $sqlWin -Force -ErrorAction SilentlyContinue
    }
}

# --- preflight -------------------------------------------------------------
$db = Assert-Identifier $Database 'Database name'

if (-not $Path -or $Path.Trim() -eq '') {
    $Path = Join-Path $env:USERPROFILE 'marina-backups'
}
$Path = [System.IO.Path]::GetFullPath($Path)
Assert-SafePath $Path | Out-Null
if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }

Say "Checking WSL ($Distro)"
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    throw "wsl.exe not found. This script needs WSL because Postgres lives inside it."
}
$probe = Invoke-Wsl 'true' -AllowFail
if ($probe.ExitCode -ne 0) {
    throw "Cannot reach WSL distro '$Distro'. Try: wsl -l -v"
}
Ok "wsl reachable"

Say "Checking Postgres (cluster $ClusterVersion)"
Invoke-Wsl "sudo pg_ctlcluster $ClusterVersion main start 2>/dev/null; true" -AllowFail | Out-Null
$ready = Invoke-Wsl 'pg_isready -h 127.0.0.1 -p 5432 -q' -AllowFail
if ($ready.ExitCode -ne 0) {
    throw "Postgres is not accepting connections on 127.0.0.1:5432. Try: wsl -d $Distro -- bash -lc 'sudo pg_ctlcluster $ClusterVersion main start'"
}
# No inline SQL here: `psql -l` lists databases without one, so the check cannot
# be broken by quoting.
$exists = Invoke-Wsl "sudo -u postgres psql -tA --no-password -l | cut -d'|' -f1 | grep -qx '$db'" -AllowFail
if ($exists.ExitCode -ne 0) {
    throw "Database '$db' does not exist in the cluster. Nothing to back up."
}
Ok "postgres up, database '$db' present"

# --- dump ------------------------------------------------------------------
$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpName  = "$db-$stamp.dump"
$rolesName = "$db-$stamp.roles.sql"
$infoName  = "$db-$stamp.info.txt"
$tmpDump   = "/tmp/$dumpName"
$tmpRoles  = "/tmp/$rolesName"
$winDump   = Join-Path $Path $dumpName
$winRoles  = Join-Path $Path $rolesName
$winInfo   = Join-Path $Path $infoName

Say "Reading current state"
$statsBefore = Get-DbStats $db $stamp
if ($statsBefore) {
    foreach ($line in $statsBefore) {
        $parts = $line -split '\|', 2
        if ($parts[0] -in @('tables', 'total_rows', 'rls_policies')) { Ok "$($parts[0]) = $($parts[1])" }
    }
} else {
    Warn "could not read database stats - continuing with the dump anyway"
}

Say "Dumping '$db'"
# Custom format: compressed, restorable selectively, and it carries RLS policies
# and GRANTs. Owners are kept (no --no-owner) so app_user's tenant-isolation
# grants come back exactly as they were.
Invoke-Wsl "sudo -u postgres pg_dump --format=custom --no-password --dbname='$db' --file='$tmpDump'" | Out-Null

# Verify BEFORE moving it: a dump that pg_restore cannot list is not a backup.
# pipefail matters - without it `wc` succeeding would mask pg_restore failing.
$listed = Invoke-Wsl "set -o pipefail; sudo -u postgres pg_restore --list '$tmpDump' | wc -l" -AllowFail
if ($listed.ExitCode -ne 0) {
    Invoke-Wsl "sudo rm -f '$tmpDump'" -AllowFail | Out-Null
    throw "pg_dump produced a file that pg_restore cannot read. The backup was NOT kept."
}
$entryCount = ($listed.Output -split "`n" | Select-Object -Last 1).Trim()
Ok "archive verified ($entryCount table-of-contents entries)"

Copy-OutOfWsl $tmpDump $winDump
Invoke-Wsl "sudo rm -f '$tmpDump'" -AllowFail | Out-Null

# Roles are cluster-level and are NOT in a database dump. Without them a restore
# onto a fresh cluster fails on the first "OWNER TO marina".
Say "Dumping cluster roles"
Invoke-Wsl "sudo -u postgres pg_dumpall --roles-only --no-password --file='$tmpRoles'" | Out-Null
Copy-OutOfWsl $tmpRoles $winRoles
Invoke-Wsl "sudo rm -f '$tmpRoles'" -AllowFail | Out-Null
Ok "roles saved (contains password hashes - keep this directory private)"

# --- manifest --------------------------------------------------------------
$dumpSize = (Get-Item $winDump).Length
$info = New-Object System.Collections.Generic.List[string]
$info.Add("marina backup manifest")
$info.Add("created_utc|$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))")
$info.Add("database|$db")
$info.Add("dump_file|$dumpName")
$info.Add("dump_bytes|$dumpSize")
$info.Add("roles_file|$rolesName")
$info.Add("toc_entries|$entryCount")
$info.Add("host|$env:COMPUTERNAME")
if ($statsBefore) { foreach ($line in $statsBefore) { $info.Add($line) } }
[System.IO.File]::WriteAllLines($winInfo, $info, (New-Object System.Text.UTF8Encoding($false)))

# --- retention -------------------------------------------------------------
if ($Keep -gt 0) {
    $all = Get-ChildItem -Path $Path -Filter "$db-*.dump" | Sort-Object LastWriteTime -Descending
    if ($all.Count -gt $Keep) {
        Say "Pruning old backups (keeping $Keep)"
        foreach ($old in $all | Select-Object -Skip $Keep) {
            $base = [System.IO.Path]::GetFileNameWithoutExtension($old.Name)
            Remove-Item $old.FullName -Force
            Remove-Item (Join-Path $Path "$base.roles.sql") -Force -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $Path "$base.info.txt")  -Force -ErrorAction SilentlyContinue
            Ok "removed $($old.Name)"
        }
    }
}

# --- done ------------------------------------------------------------------
$mb = [math]::Round($dumpSize / 1MB, 2)
if (-not $Quiet) {
    Write-Host ""
    Write-Host "  Backup complete" -ForegroundColor Green
    Write-Host "    $winDump  ($mb MB)"
    Write-Host "    $winRoles"
    Write-Host "    $winInfo"
    Write-Host ""
    Write-Host "  Restore it with:" -ForegroundColor DarkGray
    Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-local.ps1 -From `"$winDump`"" -ForegroundColor DarkGray
    Write-Host ""
}

# Machine-readable last line, so a scheduled task can grep one thing.
Write-Output "BACKUP_OK|$winDump|$dumpSize"
