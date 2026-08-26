# ---------------------------------------------------------------------------
# Restore the LOCAL marina database from a backup taken by backup-local.ps1.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-local.ps1
#   ... -From "C:\Users\me\marina-backups\marina-20260826-101500.dump"
#
# THIS DESTROYS THE CURRENT DATABASE. It drops '<database>' and rebuilds it from
# the archive. Nothing happens until you type the database name at the prompt
# (or pass -Force), and unless you pass -NoPreBackup it takes a fresh backup of
# what is about to be destroyed first.
#
# The drill this exists for is in docs/OPERATIONS.md. Run it on purpose, on a
# quiet afternoon, before you need it.
#
# NOTE ON QUOTING: the DROP/CREATE statements are written to a file and run with
# `psql -f`. Piping SQL text through PowerShell -> wsl -> bash -> psql is a
# quoting trap and has already broken once in this repo. Do not "simplify" it.
# ---------------------------------------------------------------------------
param(
    [string]$From,                  # .dump file; default = newest in -Path
    [string]$Path,                  # backup directory (default %USERPROFILE%\marina-backups)
    [string]$Database = 'marina',
    [string]$Owner    = 'marina',
    [string]$Distro   = 'Ubuntu',
    [int]$ClusterVersion = 18,
    [switch]$NoPreBackup,           # skip the safety backup of the CURRENT data
    [switch]$WithRoles,             # also load <backup>.roles.sql (fresh cluster only)
    [switch]$Force                  # skip the typed confirmation
)

$ErrorActionPreference = 'Stop'

function Say($msg)  { Write-Host "`n> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Danger($msg) { Write-Host "  $msg" -ForegroundColor Red }

# --- helpers ---------------------------------------------------------------
# Duplicated from backup-local.ps1 on purpose: a restore script has to work on
# its own, including from a rescue copy, with no sibling module to dot-source.

function ConvertTo-WslPath([string]$WinPath) {
    $full = [System.IO.Path]::GetFullPath($WinPath)
    if ($full -notmatch '^[A-Za-z]:\\') {
        throw "Only local drive paths work from WSL. Got: $full"
    }
    $drive = $full.Substring(0, 1).ToLower()
    $rest  = $full.Substring(2).Replace('\', '/')
    return "/mnt/$drive$rest"
}

function Assert-SafePath([string]$p) {
    if ($p -match "['`"]") { throw "Path contains a quote character, which cannot be passed to WSL safely: $p" }
    return $p
}

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

# Stage files into /tmp rather than reading them from /mnt/c: the postgres
# system user cannot be relied on to have access to the Windows drive mount.
function Copy-IntoWsl([string]$WinPath, [string]$WslPath) {
    $src = ConvertTo-WslPath (Assert-SafePath $WinPath)
    Invoke-Wsl "cp '$src' '$WslPath' && chmod 644 '$WslPath'" | Out-Null
}

# psql does not strip a BOM, it tries to execute it. UTF-8 without BOM, LF only.
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

# Returns an ordered hashtable of key -> value, or $null if the database could
# not be read (missing, or the cluster is down).
function Get-DbStats([string]$db, [string]$stamp) {
    $sqlWin = Join-Path $env:TEMP "marina-stats-$stamp.sql"
    $sqlWsl = "/tmp/marina-stats-$stamp.sql"
    Write-SqlFile $sqlWin (Get-StatsSql)
    try {
        Copy-IntoWsl $sqlWin $sqlWsl
        $res = Invoke-Wsl "sudo -u postgres psql -tA --no-password -v ON_ERROR_STOP=1 -d '$db' -f '$sqlWsl'" -AllowFail
        Invoke-Wsl "rm -f '$sqlWsl'" -AllowFail | Out-Null
        if ($res.ExitCode -ne 0) { return $null }
        $map = [ordered]@{}
        foreach ($line in ($res.Output -split "`n")) {
            if ($line -match '\|') {
                $parts = $line -split '\|', 2
                $map[$parts[0].Trim()] = $parts[1].Trim()
            }
        }
        return $map
    } finally {
        Remove-Item $sqlWin -Force -ErrorAction SilentlyContinue
    }
}

function Show-Stats($label, $stats) {
    if (-not $stats) { Warn "$label : unreadable"; return }
    $keys = @('tables', 'rls_tables', 'rls_policies', 'migrations_applied', 'total_rows',
              'rows.Operator', 'rows.Customer', 'rows.Order', 'rows.Payment', 'rows.AuditLog')
    Write-Host "  $label" -ForegroundColor White
    foreach ($k in $keys) {
        if ($stats.Contains($k)) { Write-Host ("    {0,-20} {1}" -f $k, $stats[$k]) }
    }
}

# --- preflight -------------------------------------------------------------
$db    = Assert-Identifier $Database 'Database name'
$owner = Assert-Identifier $Owner 'Owner role'

if (-not $Path -or $Path.Trim() -eq '') {
    $Path = Join-Path $env:USERPROFILE 'marina-backups'
}
$Path = [System.IO.Path]::GetFullPath($Path)

if (-not $From -or $From.Trim() -eq '') {
    if (-not (Test-Path $Path)) { throw "No backup directory at $Path. Run scripts\backup-local.ps1 first." }
    $newest = Get-ChildItem -Path $Path -Filter "$db-*.dump" -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $newest) { throw "No '$db-*.dump' files in $Path. Pass -From to name one explicitly." }
    $From = $newest.FullName
    Warn "no -From given; using the newest backup in $Path"
}
$From = [System.IO.Path]::GetFullPath($From)
Assert-SafePath $From | Out-Null
if (-not (Test-Path $From)) { throw "Backup file not found: $From" }

Say "Checking WSL ($Distro)"
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    throw "wsl.exe not found. This script needs WSL because Postgres lives inside it."
}
if ((Invoke-Wsl 'true' -AllowFail).ExitCode -ne 0) { throw "Cannot reach WSL distro '$Distro'. Try: wsl -l -v" }

Say "Checking Postgres (cluster $ClusterVersion)"
Invoke-Wsl "sudo pg_ctlcluster $ClusterVersion main start 2>/dev/null; true" -AllowFail | Out-Null
if ((Invoke-Wsl 'pg_isready -h 127.0.0.1 -p 5432 -q' -AllowFail).ExitCode -ne 0) {
    throw "Postgres is not accepting connections on 127.0.0.1:5432. Try: wsl -d $Distro -- bash -lc 'sudo pg_ctlcluster $ClusterVersion main start'"
}
Ok "postgres up"

# --- inspect the archive ---------------------------------------------------
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$tmpDump = "/tmp/marina-restore-$stamp.dump"

Say "Verifying the archive"
Copy-IntoWsl $From $tmpDump
# pipefail so a broken archive is not masked by wc succeeding.
$toc = Invoke-Wsl "set -o pipefail; sudo -u postgres pg_restore --list '$tmpDump' | wc -l" -AllowFail
if ($toc.ExitCode -ne 0) {
    Invoke-Wsl "rm -f '$tmpDump'" -AllowFail | Out-Null
    throw "pg_restore cannot read $From. It is not a custom-format dump, or it is corrupt. NOTHING was changed."
}
$tocEntries = ($toc.Output -split "`n" | Select-Object -Last 1).Trim()
$sizeMb = [math]::Round((Get-Item $From).Length / 1MB, 2)
Ok "archive readable - $tocEntries entries, $sizeMb MB"

# Sidecars share the dump's base name: <db>-<stamp>.dump / .info.txt / .roles.sql
$backupDir  = [System.IO.Path]::GetDirectoryName($From)
$backupBase = [System.IO.Path]::GetFileNameWithoutExtension($From)
$manifestPath = Join-Path $backupDir "$backupBase.info.txt"
$manifest = $null
if (Test-Path $manifestPath) {
    $manifest = [ordered]@{}
    foreach ($line in (Get-Content $manifestPath)) {
        if ($line -match '\|') {
            $parts = $line -split '\|', 2
            $manifest[$parts[0].Trim()] = $parts[1].Trim()
        }
    }
    Ok "manifest found: taken $($manifest['created_utc']) with $($manifest['total_rows']) rows"
} else {
    Warn "no .info.txt beside the dump - the after-restore comparison will be limited"
}

# --- show what is about to be destroyed ------------------------------------
Say "Current database"
$before = Get-DbStats $db $stamp
Show-Stats "$db (now, about to be REPLACED)" $before

Write-Host ""
Danger "  This DROPS the database '$db' and rebuilds it from:"
Danger "    $From"
if ($before) {
    Danger "  You will lose the $($before['total_rows']) rows listed above unless they are in that file."
}
Write-Host ""

if (-not $Force) {
    if (-not [Environment]::UserInteractive) {
        Invoke-Wsl "rm -f '$tmpDump'" -AllowFail | Out-Null
        throw "Refusing to restore without confirmation in a non-interactive session. Pass -Force if you mean it."
    }
    $answer = Read-Host "  Type the database name ($db) to continue, anything else to abort"
    if ($answer -ne $db) {
        Invoke-Wsl "rm -f '$tmpDump'" -AllowFail | Out-Null
        Write-Host "  Aborted. Nothing was changed." -ForegroundColor Yellow
        exit 1
    }
}

# --- safety backup of what we are about to destroy -------------------------
if (-not $NoPreBackup -and $before) {
    Say "Backing up the CURRENT database first"
    $backupScript = Join-Path $PSScriptRoot 'backup-local.ps1'
    if (-not (Test-Path $backupScript)) {
        throw "backup-local.ps1 not found next to this script. Pass -NoPreBackup to restore without a safety copy."
    }
    # -Keep 0 so the safety copy can never be pruned by the retention rule.
    $result = & $backupScript -Path $Path -Database $db -Distro $Distro -ClusterVersion $ClusterVersion -Keep 0 -Quiet
    $line = ($result | Where-Object { $_ -like 'BACKUP_OK|*' } | Select-Object -Last 1)
    if (-not $line) { throw "The safety backup did not report success. Refusing to restore." }
    Ok "safety copy: $(($line -split '\|')[1])"
} elseif (-not $before) {
    Warn "database '$db' is missing or unreadable - nothing to back up first"
}

# --- rebuild ---------------------------------------------------------------
# DROP DATABASE cannot run while anything is connected, and it cannot run inside
# a transaction. Statements go in a file, and psql runs them one at a time in
# autocommit with ON_ERROR_STOP so the first failure halts the script.
$prepSqlWin = Join-Path $env:TEMP "marina-restore-prep-$stamp.sql"
$prepSqlWsl = "/tmp/marina-restore-prep-$stamp.sql"
$prepSql = @"
-- Generated by scripts/restore-local.ps1. Safe to delete.
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$db' AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS $db WITH (FORCE);

CREATE DATABASE $db OWNER $owner;
"@

Say "Rebuilding '$db'"
Warn "stop 'pnpm dev:local' now if it is running - open connections are terminated"
Write-SqlFile $prepSqlWin $prepSql
try {
    Copy-IntoWsl $prepSqlWin $prepSqlWsl
    Invoke-Wsl "sudo -u postgres psql --no-password -v ON_ERROR_STOP=1 -d postgres -f '$prepSqlWsl'" | Out-Null
    Ok "empty database created, owned by $owner"
} finally {
    Invoke-Wsl "rm -f '$prepSqlWsl'" -AllowFail | Out-Null
    Remove-Item $prepSqlWin -Force -ErrorAction SilentlyContinue
}

Say "Restoring data"
# --exit-on-error, not the default "keep going": a half-restored database that
# reports success is the worst possible outcome of a restore drill.
# Owners and ACLs are restored as dumped, so app_user's RLS grants come back.
$restore = Invoke-Wsl "sudo -u postgres pg_restore --no-password --exit-on-error --dbname='$db' '$tmpDump'" -AllowFail
Invoke-Wsl "rm -f '$tmpDump'" -AllowFail | Out-Null
if ($restore.ExitCode -ne 0) {
    Danger "RESTORE FAILED - the database is now EMPTY or partial."
    Write-Host $restore.Output
    throw "pg_restore exited $($restore.ExitCode). Fix the cause, then re-run with the same -From."
}
Ok "data restored"

if ($WithRoles) {
    $rolesFile = Join-Path $backupDir "$backupBase.roles.sql"
    if (Test-Path $rolesFile) {
        Say "Loading cluster roles"
        $rolesWsl = "/tmp/marina-roles-$stamp.sql"
        Copy-IntoWsl $rolesFile $rolesWsl
        # No ON_ERROR_STOP: roles that already exist raise errors that are fine
        # to ignore. This step only matters on a rebuilt cluster.
        $roles = Invoke-Wsl "sudo -u postgres psql --no-password -d postgres -f '$rolesWsl'" -AllowFail
        Invoke-Wsl "rm -f '$rolesWsl'" -AllowFail | Out-Null
        if ($roles.ExitCode -ne 0) { Warn "some role statements failed (usually 'already exists') - review if a login now fails" }
        else { Ok "roles loaded" }
    } else {
        Warn "no roles file beside the dump; skipping -WithRoles"
    }
}

# --- verify ----------------------------------------------------------------
Say "Verifying the restore"
$after = Get-DbStats $db $stamp
Show-Stats "$db (restored)" $after

$problems = New-Object System.Collections.Generic.List[string]
if (-not $after) {
    $problems.Add("the restored database could not be read at all")
} else {
    if ([int]$after['tables'] -eq 0) { $problems.Add("no tables were restored") }
    if ([int]$after['rls_policies'] -eq 0) {
        $problems.Add("no RLS policies present - tenant isolation is OFF. Run: pnpm db:rls")
    }
    if ($manifest) {
        foreach ($key in @('tables', 'rls_policies', 'total_rows')) {
            if ($manifest.Contains($key) -and $after.Contains($key) -and $manifest[$key] -ne $after[$key]) {
                $problems.Add("$key differs from the manifest: backup said $($manifest[$key]), restored has $($after[$key])")
            }
        }
    }
}

Write-Host ""
if ($problems.Count -gt 0) {
    Danger "Restore finished with problems:"
    foreach ($p in $problems) { Danger "  - $p" }
    Write-Host ""
    Write-Output "RESTORE_WARN|$From"
    exit 2
}

Write-Host "  Restore complete and verified against the backup manifest." -ForegroundColor Green
Write-Host ""
Write-Host "  Next:" -ForegroundColor DarkGray
Write-Host "    1. pnpm db:migrate:deploy   (only if the backup predates the current migrations)" -ForegroundColor DarkGray
Write-Host "    2. pnpm dev:local           (bring the apps back up)" -ForegroundColor DarkGray
Write-Host "    3. open http://localhost:3001/health/ready and confirm status ok" -ForegroundColor DarkGray
Write-Host ""
Write-Output "RESTORE_OK|$From"
