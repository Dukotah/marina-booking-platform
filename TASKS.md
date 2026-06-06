# Tasks — Phase 1: Wire the Cockpit

> Small, discrete, checkable. Status: `todo` · `doing` · `done`. Each task is done
> only when typecheck + the relevant build pass and (where it applies) the live
> suite for the touched area is green. Newest phase at top; see [`ROADMAP.md`](ROADMAP.md)
> for the phase plan and [`PROGRESS.md`](PROGRESS.md) for the running log.

Branch: `phase-1-cockpit` (committed locally; not pushed — Vercel quota, see D-027).

| # | Task | Status |
|---|------|--------|
| 1.1 | **Customer email-OTP login UI** (web): `/login` screen → request code → verify → session cookie; wire the account area to use it instead of the order#+email stub. Flips 0.7 fully ✅. | done |
| 1.2 | **Admin Gift Cards page** (`/giftcards` + nav): list/search, issue, view detail with balance + ledger, redeem, adjust, void/reactivate. | todo |
| 1.3 | **Admin Resources/Assets page** (`/resources` + nav): list, create/edit (seat_capacity, quantity, out_of_service, allocation mode), activity assignment, derived availableQty. The moat, made visible. | todo |
| 1.4 | **Admin Waiver Templates** management (Settings → Policies/Waivers): list versions + signature counts, publish a new version, activate. | todo |
| 1.5 | **Reports: By-Location tab** — per-location gross/volume roll-up + chain total + CSV (D-020). | todo |
| 1.6 | **Reports: Accounting tab** — payment-level transactions journal keyed by cash date, per-tender reconciliation + CSV (D-021). | todo |
| 1.7 | **POS gift-card tender** — accept a gift card as a tender in the POS payment panel (backend D-015 exists). | todo |
| 1.8 | **Verification + cleanup pass** — stand the full stack up once, browser-smoke every route + the touched flows (incl. the 1.1 login E2E), run touched live suites green, fix any broken page/empty state, stage the clean Phase-1 PR. | todo |

## Notes / decisions pending within the phase
- **1.2 / 1.3 data path:** admin reads via direct DB (D-007), but gift-card &
  resource *services* live in `apps/api`. Decision when starting 1.2: either the
  admin server actions call the API with a staff identity, or extract the service
  logic to `@marina/core` (D-008 home for "writes both sides perform"). Default
  lean: **call the API from admin server actions** using the dev-staff shim now
  (Clerk-bearer forwarding when enforced) — smaller, no refactor of live-tested
  services. Revisit if the auth-forwarding gets ugly. → logged as a DECISIONS entry
  when chosen.
- **1.5 / 1.6:** prefer extracting aggregation to `@marina/core` if the admin
  direct-DB path would duplicate the API route logic (see IMPROVEMENTS).
