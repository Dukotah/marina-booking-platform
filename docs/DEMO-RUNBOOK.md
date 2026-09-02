# Demo Runbook — Lake Sonoma Marina Booking Platform

How to go from a cold Windows + WSL machine to a live, full-stack demo in front of a
client. Everything here runs locally with zero external accounts.

---

## 0. Before anything: WSL2 networking note

WSL2 runs behind NAT. Windows `localhost` does NOT reliably reach WSL services.
Browse the demo from Windows using the WSL IP address, not `localhost`.

Find it fresh every session (it can change on restart):

```bash
# In WSL terminal
hostname -I
# Example output: 172.22.208.63 — use this IP in the Windows browser
```

| Service | Windows browser URL |
|---|---|
| Customer booking app | `http://<WSL_IP>:3000` |
| API health | `http://<WSL_IP>:3001/health` |
| Admin / operator console | `http://<WSL_IP>:3002` |
| LakeSonoma marketing site | `http://<WSL_IP>:3005` |

Permanent fix (optional): add `[wsl2]\nnetworkingMode=mirrored` to
`%USERPROFILE%\.wslconfig`, then run `wsl --shutdown` and restart WSL. After that,
plain `localhost` works.

---

## 1. Start Postgres

Open a WSL terminal. Postgres must be running before any app starts.

```bash
sudo service postgresql start
```

If the service is already running the command is a no-op. Verify:

```bash
pg_isready -h 127.0.0.1 -p 5432 -U marina
# Expected: 127.0.0.1:5432 - accepting connections
```

---

## 2. Boot the booking stack (web + API + admin)

Every shell that touches this repo needs the PATH extended and `.env` sourced. This
is the canonical header — paste it verbatim when starting a fresh terminal:

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd /home/dukotah/marina-demo
set -a; . ./.env; set +a
```

Then check whether the stack is already running from a previous session:

```bash
curl -s -o /dev/null -w '%{http_code}' localhost:3001/health
# 200 = already up, skip to step 3
# 000 = not running, continue below
```

If it is not running, boot it in the background:

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd /home/dukotah/marina-demo
set -a; . ./.env; set +a
nohup pnpm dev >>/tmp/marina-dev.log 2>&1 &
```

Poll until all three ports answer (takes 30-90 seconds on first boot):

```bash
until curl -s -o /dev/null -w '' http://localhost:3001/health && \
      curl -s -o /dev/null -w '' http://localhost:3000/ && \
      curl -s -o /dev/null -w '' http://localhost:3002/; do
  echo "waiting…"; sleep 5
done
echo "Stack is up."
```

If any port reports EADDRINUSE, kill the old processes and retry:

```bash
fuser -k 3000/tcp 3001/tcp 3002/tcp
pkill -f "turbo run dev"
# Then re-run the nohup line above
```

Watch the log if something does not come up:

```bash
tail -f /tmp/marina-dev.log
```

---

## 3. Boot the LakeSonoma marketing site

The marketing site lives in a separate repo and needs `NEXT_PUBLIC_BOOKING_URL` so
its "Book Now" buttons deep-link into the running booking app.

Open a second WSL terminal:

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd /mnt/c/Users/dukot/projects/LakeSonoma

# Point every CTA at the local booking app
export NEXT_PUBLIC_BOOKING_URL="http://localhost:3000"

# Boot on port 3005 (3000 is taken by the booking app)
npx next dev -p 3005
```

Wait for `Ready in Xms` in the output, then open `http://<WSL_IP>:3005` in the
Windows browser.

If the site returns 500 errors after resuming a previous session, the `.next` build
cache is stale. Clear it and restart:

```bash
fuser -k 3005/tcp
rm -rf /mnt/c/Users/dukot/projects/LakeSonoma/.next
npx next dev -p 3005
```

---

## 4. Warm the routes (do this before the client arrives)

Hitting each URL once causes Next.js to pre-render the pages and warms the API
route caches, so the first demo click is instant rather than showing a loading
spinner.

```bash
# Run from any WSL terminal with the PATH line already loaded
curl -s -o /dev/null -w "web    %{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "admin  %{http_code}\n" http://localhost:3002/platform
curl -s -o /dev/null -w "api    %{http_code}\n" http://localhost:3001/health
curl -s -o /dev/null -w "lsra   %{http_code}\n" http://localhost:3005/
```

All four should return 200. Open `http://<WSL_IP>:3000` and
`http://<WSL_IP>:3005` in a Windows browser and click through one activity so the
photo assets are cached.

---

## 5. Five-minute demo walkthrough

Run this in order. The whole sequence takes 5-8 minutes.

### Step 1: Customer books (marketing site → booking app)

Set the Windows browser window to a phone-sized viewport (DevTools → 390 px wide)
to show the mobile experience.

1. Open `http://<WSL_IP>:3005` — the Lake Sonoma Marina marketing site.
2. Click any boat rental (e.g. 5-Person Pontoon). Show the photo, rates, capacity.
3. Click **Book Now** — a new tab opens on the booking app (`http://<WSL_IP>:3000`).
4. On the activity page: pick a **rate** (e.g. Half Day — $350), then select a
   **date** on the availability calendar, then choose an available **time slot**.
   The "Continue to checkout" button activates once all three are chosen.
5. Click **Continue to checkout**.
6. Fill in **guest details** (name + email + phone — this is what the marina staff
   sees on the manifest).
7. Sign the **liability waiver** (initials + date of birth + full signature).
   Emphasise: the waiver is captured digitally — no paper.
8. Optionally apply a **promo code** or add a **tip**.
9. The payment section reads **"Reserve now, pay at the marina"** — click
   **Complete reservation**. No card is required. This is the "pay at the marina"
   flow.
10. The **confirmation page** appears with an order number and a QR check-in code.
    Copy the order number for the next step.

Talking point: "That is the full guest experience — no app to install, waiver
captured, confirmation sent, and the marina has everything it needs before the
customer arrives."

### Step 2: Operator manifest and check-in

Open a second browser window (or tab) at `http://<WSL_IP>:3002`.

1. **Dashboard** — the booking you just made appears in today's revenue total.
2. Navigate to **Manifest** — find the booking in the day sheet.
3. One-tap **Check in** the guest. The row updates instantly.
4. Show **no-show** then **undo** — the status cycles and the capacity is restored.

Talking point: "Everything the front desk needs on one screen. No legacy console,
no separate login."

### Step 3: Post-trip charge / refund

From **Orders**, open the order you just created.

1. Show the full timeline: items, rate, waiver status, payment status.
2. Issue a **partial refund** (e.g. $50 off) — the ledger and balance update in
   place.
3. Show a **full refund** on a different order if one exists, then undo it.

Talking point: "Refunds are instant from the same screen — no calling a third-party
support line."

### Step 4: Reports daily stepper

Navigate to **Reports** (or the Revenue section of the Dashboard).

1. Step through the **daily revenue chart** — each day's total is clickable.
2. Export a **CSV** for the current period.
3. Show **occupancy** — how many slots were filled vs available.

Talking point: "Full reporting baked in — no spreadsheet export to Excel, no manual
reconciliation."

### Step 5 (optional): The agency angle

Navigate to `http://<WSL_IP>:3002/platform`.

1. Both operators are listed: **Lake Sonoma Marina** and **Russian River Kayak Co**.
2. Click "Open dashboard" on Russian River Kayak Co — you are now running their
   marina. Their data is completely isolated from Lake Sonoma's.
3. Click the exit banner to switch back.

Talking point: "This is a platform, not a one-marina app. I can onboard any operator
in minutes and their data is fully isolated."

---

## 6. What is simulated in the demo

| Feature | In the demo | Notes |
|---|---|---|
| Payments | "Reserve now, pay at the marina" — no charge taken | `PAYMENT_MODE=reserve` in `.env`. No Stripe account needed. Customer checkout completes without a card. |
| Email / SMS notifications | Log to API console only, never sent | `RESEND_API_KEY` and Twilio keys are not set. Every booking flow still completes normally. |
| Staff auth | Dev OWNER fallback — no password | `REQUIRE_CLERK_AUTH=false`. Admin opens without login. |
| Card form | Not shown | Because `PAYMENT_MODE=reserve`, the Stripe card step is replaced with the "pay at marina" UI. |

No customer-facing screen uses the words "demo", "fake", "test", or "sandbox". The
UI is production copy throughout.

---

## 7. What is fully real

- Postgres database with real schema, RLS tenant isolation, and real LSRA seed data.
- 22 activities and 2,681+ future timeslots generated by the catalog sync script.
- Two live operators: `lake-sonoma` (Lake Sonoma Marina) and `russian-river-kayak`.
- Availability logic: real capacity, real slot generation, real past-date blocking.
- Waiver capture: legally-structured fields (initials, DOB, signature) stored in DB.
- Promo code engine: codes create real discount line items in the order.
- Manifest, check-in, no-show, and check-in undo are all real database operations.
- Refunds update the order ledger exactly as they would in production.
- Reports and CSV export query the real booking data.
- Entire flow: 376 integration tests pass against the same local Postgres. Typecheck
  is clean on 9/9 packages.

---

## 8. Reset between demos

The seed is idempotent. To get a clean slate (no test orders, fresh timeslots):

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd /home/dukotah/marina-demo
set -a; . ./.env; set +a
pnpm db:seed
```

This wipes and recreates the LSRA tenant data. The stack does not need to be
restarted after a reseed — the API picks up the new data on the next request.

Do not reseed while the API is handling an in-flight checkout — wait for the
confirmation page to appear first.
