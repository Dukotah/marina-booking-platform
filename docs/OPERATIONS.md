# Operations — backup, restore, health, errors

This is the "can we safely run a real marina on it" file. Three things live here:

1. **Backup and restore** — how to take one, how to put it back, and the drill you
   run *before* you need it.
2. **Health endpoints** — what each one means and what to do when it goes red.
3. **Errors** — where a crash goes, locally and in the cloud.

Everything below works on the owner's laptop with **no account anywhere**, per
[`LOCAL-FIRST-BUILD.md`](LOCAL-FIRST-BUILD.md) §0.

---

## 1. Backup

### Take one

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-local.ps1
```

Postgres lives inside WSL Ubuntu (cluster 18). The script starts the cluster if it
is down, runs `pg_dump` **inside WSL**, verifies the archive, then copies it out to
Windows. It takes seconds on a database this size.

You get three files per run, in `%USERPROFILE%\marina-backups`:

| File | What it is |
|---|---|
| `marina-<stamp>.dump` | Custom-format `pg_dump`: schema, data, **RLS policies**, and grants |
| `marina-<stamp>.roles.sql` | Cluster roles (`marina`, `app_user`) — needed only when rebuilding a cluster from scratch |
| `marina-<stamp>.info.txt` | What was in the database at dump time: table count, RLS policy count, row counts |

The `.info.txt` is not decoration. `restore-local.ps1` reads it back and compares,
so a restore that silently lost half the rows fails loudly instead of looking fine.

### Options

| Flag | Default | Why you'd change it |
|---|---|---|
| `-Path <dir>` | `%USERPROFILE%\marina-backups` | Put backups on an external drive |
| `-Keep <n>` | `10` | Retention. `0` keeps everything |
| `-Database <name>` | `marina` | Another database in the same cluster |
| `-Quiet` | off | For scheduled runs — prints only the final `BACKUP_OK\|...` line |

### Two things the backup does NOT contain

- **`.env`** — the connection strings and the `APP_DB_PASSWORD`. It is gitignored on
  purpose, which also means nothing else is copying it. Keep a copy somewhere safe.
- **Uploaded files** under `.sandbox/uploads` (the local `storage` driver). The
  database holds the file *records*; the bytes sit on disk. Copy that folder too if
  a booking's uploads matter to you.

The `.roles.sql` **contains role password hashes**. That is why backups default to
your user profile and not into the repo — do not move them somewhere shared, and do
not commit them.

### Schedule it (optional)

```powershell
schtasks /Create /TN "Marina nightly backup" /SC DAILY /ST 02:00 ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\dukot\projects\marina-booking-platform\scripts\backup-local.ps1 -Quiet"
```

Caveat worth knowing: WSL needs your user session, so a scheduled run only works
while you are logged in. Treat the schedule as a convenience and take a manual
backup before anything risky — a migration, a seed reset, a big refactor.

---

## 2. Restore — the drill

**Run this drill once, on purpose, before you need it.** A backup nobody has ever
restored is a guess, not a backup.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-local.ps1
```

With no `-From` it picks the newest backup in the backup directory and says so.

### What happens, in order

1. **Verifies the archive** — `pg_restore --list` must read it. If it cannot, the
   script stops and **nothing is changed**.
2. **Shows you what you are about to destroy** — current table count, RLS policy
   count, and row counts, next to the manifest of the backup going in.
3. **Asks you to type the database name.** Anything else aborts. `-Force` skips the
   prompt (for a scripted drill); in a non-interactive session without `-Force` the
   script refuses rather than guessing.
4. **Backs up the current data first** — a safety copy with `-Keep 0` so retention
   can never prune it. Skip with `-NoPreBackup` if you know the current state is
   garbage.
5. **Drops and recreates the database**, then restores with `--exit-on-error`. A
   half-restored database that reports success is the worst possible outcome, so any
   error stops it.
6. **Verifies** — re-reads the row counts and compares against the manifest, and
   checks that **RLS policies came back**. Mismatches are printed and the script
   exits `2`.

Stop `pnpm dev:local` before step 5. The script terminates open connections (it has
to, or `DROP DATABASE` cannot run), and a running API will just reconnect to a
database that is being rebuilt underneath it.

### After a restore

```powershell
pnpm db:migrate:deploy   # only if the backup predates the current migrations
pnpm dev:local
```

Then open `http://localhost:3001/health/ready` and confirm `"status": "ok"`.

### Reading the verification

| Line | Means |
|---|---|
| `Restore complete and verified against the backup manifest.` | Row counts, table count and policy count all match the backup. Done. |
| `no RLS policies present - tenant isolation is OFF` | The restore worked but policies did not come back. **Fix before using it:** `pnpm db:rls` |
| `total_rows differs from the manifest` | The archive was truncated or the wrong file. Try the previous backup. |
| `RESTORE FAILED - the database is now EMPTY or partial` | `pg_restore` errored mid-way. The database is *not* usable. Re-run with the same `-From`, or fall back to the safety copy the script just took. |

### When things are worse than a bad restore

| Situation | Do this |
|---|---|
| Cluster will not start | `wsl -d Ubuntu -- bash -lc "sudo pg_ctlcluster 18 main start"` and read the error. Logs: `/var/log/postgresql/postgresql-18-main.log` |
| Database dropped or corrupted | `restore-local.ps1 -From <newest good dump>` |
| Whole WSL distro gone | Reinstall Postgres 18, then `restore-local.ps1 -From <dump> -WithRoles` — `-WithRoles` loads the roles the dump's grants depend on |
| No backup at all, dev data only | `pnpm db:migrate:deploy` then `pnpm db:reset` to rebuild the seeded season |

---

## 3. Health endpoints

Defined in `apps/api/src/routes/health.ts`.

> **Wiring:** this router is written but **not mounted yet**. `apps/api/src/app.ts`
> owns its own routing table and currently answers a one-line `GET /health`. To turn
> these on, add `import { health } from './routes/health.js';` and
> `app.route('/health', health);` in place of that line — outside the `/api` tenant
> middleware, since health checks carry no tenant.

| Endpoint | Question it answers | Touches the DB |
|---|---|---|
| `GET /health` and `GET /health/live` | Is the process alive? | No |
| `GET /health/ready` | Can it actually serve a request? | Yes |
| `GET /health/info` | What build is this? | No |

### Why two of them

**Liveness** deliberately checks nothing external. A failing liveness check means
"kill this process and start a new one" — and restarting the API does not fix a
database that is down. Wiring the database into liveness turns a recoverable outage
into a crash loop. **Readiness** means "stop sending me traffic", which is the right
answer when the database is unreachable.

### What readiness checks

| Check | `ok` | Not ok |
|---|---|---|
| `database` | Counted operators inside the timeout | `error` → cluster down, wrong `DATABASE_URL`, or migrations never ran. **Readiness returns 503.** |
| `migrations` | Every migration finished | `warn` → a migration is unfinished or rolled back; the schema is in a state nobody designed. Run `pnpm db:migrate:deploy` |
| `sandbox` | Mode matches the environment | `warn` → `SANDBOX=local` in a production build, meaning payments, email and SMS are **simulated**. Set `SANDBOX=cloud` |

Overall `status` is the worst of the three. HTTP is **200 for `ok` and `degraded`,
503 only for `error`** — a degraded process still returns correct responses, and
pulling it out of rotation would trade a warning for an outage.

`HEALTH_TIMEOUT_MS` (default 2000) bounds each check. A check that hangs is a failed
check; nobody should wait out a TCP timeout to learn the database is gone.

### Keep it internal

`/health/ready` reports migration names and a scrubbed error string. Useful to you,
useful to an attacker. Put it behind the load balancer or on an internal address —
not on the public internet.

### What to monitor

Start with four things. More than this and you will stop reading it.

| Watch | Alert when | Because |
|---|---|---|
| `GET /health/ready` status | not `ok` for 2 consecutive minutes | The single "is it working" signal |
| `checks.database.latencyMs` | over ~500ms sustained | The cluster is struggling before it fails |
| `[errors]` lines in the API log | any `fatal`, or a spike in one fingerprint | One bug repeating is louder than many |
| Backup age | newest `.dump` older than 48h | The schedule silently stopped |

---

## 4. Errors

`apps/api/src/services/errors.ts`. One function, `captureError(err, context)`, with
two drivers chosen by the same `SANDBOX` rule everything else uses.

| Mode | Where errors go |
|---|---|
| `local` (default outside production) | A `SandboxError` row **plus** a console line. The Local Console's Errors panel reads the table. |
| `cloud` | A Sentry event over plain HTTP, plus the same console line. Needs `SENTRY_DSN`. |

Both drivers always write to stderr first. The row or the Sentry event is the
searchable copy; the console line is the one that still exists when the database is
the thing that broke.

### It never throws

`captureError` swallows everything. An error sink that throws turns one bug into
two, and the second one is inside the handler that was supposed to explain the
first. When it cannot store an event it re-emits the whole thing under
`[errors] LOST EVENT` — greppable, so a lost row is never a lost record.

### What it will not store

Error messages are the most likely place for a secret to leak: a Prisma connection
error quotes the connection string, a failed fetch quotes the `Authorization`
header, a validation error quotes the input it rejected — which at checkout can be a
card number. Every string is scrubbed on the way in:

- connection-string passwords → `postgresql://marina:[redacted]@...`
- `sk_` / `rk_` / `whsec_` keys, bearer tokens, JWTs, PEM blocks → `[redacted]`
- `password=`, `"token":`, `cvc:` values → `[redacted]`
- anything that passes a Luhn check → `****4242`

Stored context is limited to operator, route, method, actor id, request id and IP.
Never a name, an email, or a phone number.

### Grouping and volume

Each throw is its own row (so "exactly one error fired" stays testable), but every
row carries a `fingerprint` — a hash of the error name, the *shape* of the message
with ids and numbers collapsed, and the first stack frame that is ours. The console
groups on it. `ERROR_BURST_LIMIT` (default 100 per fingerprint per minute, `0`
disables) stops a retry storm from writing a million rows; when it trips it says so
and reports how many it dropped.

### Wiring

Not yet mounted either — `app.ts` is owned elsewhere. The intended call site is the
existing `app.onError` handler:

```ts
import { captureHonoError } from './services/errors.js';

app.onError((err, c) => {
  if (err instanceof AuthorizationError) {
    return c.json({ error: err.message, permission: err.permission }, 403);
  }
  void captureHonoError(err, c);          // never awaited, never throws
  return c.json({ error: 'Internal server error' }, 500);
});
```

`captureHonoError` pulls operator, route, actor and request id off the Hono context
for you.

### Cutover (§6 of the build contract)

| Local driver | Cloud twin | Env to swap |
|---|---|---|
| `SandboxError` table + console | Sentry | `SANDBOX=cloud`, `SENTRY_DSN=https://...` |

Optional in cloud mode: `SENTRY_ENVIRONMENT` (defaults to `NODE_ENV`),
`SENTRY_RELEASE` (defaults to `APP_VERSION`), `SENTRY_TIMEOUT_MS` (default 3000).

The cloud driver posts a Sentry envelope with `fetch` rather than pulling in
`@sentry/node`, so the product compiles and runs with no Sentry account. What that
gives up: breadcrumbs, automatic instrumentation, release health, source-map
resolution, and on-disk retry buffering. If any of those become necessary, swap that
driver's body for the SDK — the `ErrorSink` interface does not change.

---

## 5. Known gaps

Stated plainly, so nobody assumes otherwise:

- The health router and the error sink are **written but not mounted**. See the two
  Wiring notes above.
- The Sentry cloud driver has **never been run against a live Sentry** — by design,
  there is no account. The envelope format and DSN parsing are unit-verifiable; the
  round trip is not, until someone provides a DSN.
- Backups cover the database only, not `.env` and not `.sandbox/uploads`.
- There is no automated verification that a scheduled backup ran. Watch the age of
  the newest `.dump`.
