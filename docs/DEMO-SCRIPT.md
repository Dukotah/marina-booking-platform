# Marina — Owner Demo Script

A 5–8 minute walkthrough that proves the whole system works end to end. Runs fully
locally with **fake payments** (no Stripe/Clerk/Resend/Twilio accounts needed).
Operator on screen: **Lake Sonoma Marina** (`lake-sonoma`).

---

## 0. Bring the stack up (one time, before the owner arrives)

```bash
cd ~/marina-main
export PATH="$HOME/.npm-global/bin:$PATH"
sudo service postgresql start            # if not already running
set -a; . ./.env; set +a                 # REQUIRE_CLERK_AUTH=false, DEV_FAKE_PAYMENTS=true
pnpm dev                                  # web :3000, admin :3002, api :3001
```

Then **warm the routes** so the first click in front of the owner is instant:

```bash
curl -s -o /dev/null -w "web %{http_code}\n"   http://localhost:3000/
curl -s -o /dev/null -w "admin %{http_code}\n" http://localhost:3002/platform
curl -s -H "x-operator-slug: lake-sonoma" -o /dev/null -w "api %{http_code}\n" http://localhost:3001/api/activities
```

**Reaching it from Windows:** WSL2 doesn't forward `localhost` cleanly. Use the WSL IP:

- Customer site: `http://<WSL_IP>:3000`  (today: `http://172.22.208.63:3000`)
- Operator console: `http://<WSL_IP>:3002`
- The IP can change on WSL restart — re-check with `hostname -I`.
- Permanent fix: add `[wsl2]\nnetworkingMode=mirrored` to `.wslconfig` and `wsl --shutdown`,
  then plain `localhost` works.

---

## 1. Customer books a trip (the money path)  → customer site :3000

1. **Browse** the catalog — real activities, search, category/price filters.
2. Open an activity (e.g. a pontoon or kayak trip). Show photos, description, rates.
3. **Pick a date** on the availability calendar → a time slot (shows real "spots left").
   *(The calendar only offers today onward — past dates are never bookable.)*
4. Choose a **rate** and party size.
5. **Checkout**: fill guest details, sign the **waiver** (initials + DOB + signature),
   apply a **promo code** (the discount now shows the code correctly), add a **tip**.
6. **Pay** with the fake card → land on the **confirmation** page with an order number
   and a QR check-in code.

> Talking point: "That was the full guest experience — no app to install, waiver captured,
> money taken, confirmation sent."

---

## 2. Same booking, operator side  → operator console :3002

1. **Orders** — the booking you just made is already here. Open it: items, payment,
   timeline, waiver status.
2. **Manifest** (today) — the guest is on the dense day sheet. **Check them in** with one tap.
3. **Dashboard** — revenue ticked up. Open **Reports → Revenue**, export CSV.
4. **Refund** — from the order, issue a partial or full refund; the ledger + balance update.
5. **POS** — ring up a walk-up sale (activity + merchandise, cash/card) to show day-of ops.

> Talking point: "Everything the front desk needs on one screen — manifest, check-in,
> POS, refunds, reporting — no separate legacy console like Singenuity."

---

## 3. The agency angle (this is a platform, not one marina)  → :3002/platform

1. **/platform** — every client with live revenue.
2. **"Open dashboard"** on a second client (Russian River Kayak Co) → you're now running
   *their* marina, isolated data, with an exit banner.
3. (Optional) **New client** — provision a fresh operator account in one form.

> Talking point: "This isn't just your marina. I can stand up any operator on it in minutes."

---

## What to say about "is it done"

- **The product is built and verified**: 708 automated tests pass (unit + integration
  against a live database), plus a browser end-to-end suite; all three apps build for
  production; the database stands up cleanly from zero.
- **Hardened this pass**: past-date booking blocked, payment double-charge protection,
  refund/redemption/POS concurrency guards, reminder-cron robustness — plus database-level
  integrity backstops.
- **Not wired yet (intentionally, for go-live)**: real Stripe / Clerk / Resend / Twilio
  accounts. The code has clean seams for all four and runs on fakes until then — see
  `docs/GO-LIVE.md`.
- **Known incomplete (hidden in the demo)**: sellable checkout **add-ons** are half-wired
  (service layer + tests exist, not connected to checkout) — no add-on offers are seeded,
  so nothing broken shows. Wire it when you want to upsell.

---

## Reset between demos

The seed is re-runnable. To get a clean slate (fresh timeslots, no test orders):

```bash
cd ~/marina-main && export PATH="$HOME/.npm-global/bin:$PATH"
set -a; . ./.env; set +a
pnpm db:seed        # idempotent; regenerates timeslots
```
