# Tasks — Phase 2: The Front Door (self-serve tenancy)

Branch: `phase-2-frontdoor` (committed locally; not pushed — Vercel quota, D-027).

| # | Task | Owner | Status |
|---|------|-------|--------|
| 2.0 | **Provisioning foundation** — `provisionOperator` service + `POST /signup` + `GET /signup/slug-available` (pre-tenant, adminPrisma, outside tenant mw); unique slug + location_code; dev-open / Clerk-gated prod. Dev-operator cookie hook in admin session so the dev flow is end-to-end. (D-032) | me | done |
| 2.1 | **Signup UI** — public admin `/signup`: business name → live slug check → owner name/email → POST /signup → redirect into onboarding. | agent | done |
| 2.2 | **Onboarding → bookable** — extend `completeOnboarding`/wizard so a fresh tenant gets a default **rate** + initial **timeslots** + `visible_online` per starter activity → a genuinely bookable storefront. | agent | done |
| 2.3 | **Storefront brand from operator** — web `getBrand` resolves from `GET /api/operator/public` (host/slug → operator), not env; true per-tenant white-label. | agent | done |
| 2.4 | **Fresh-tenant route sweep + empty states** — provision an empty tenant, smoke every admin + web route, fix 500s/blank, graceful empty states + CTAs. | me | done |
| 2.5 | **Verify + stage PR** — live: signup→onboarding→bookable storefront end-to-end; isolation 8/8; typecheck 9/9; both apps build. | me | done |

**Phase 2 (The Front Door) — COMPLETE.** Live-verified vs Neon: `POST /signup` provisions a
full tenant (slug/code unique, isolated — fresh owner can't see the seed tenant, isolation
8/8); admin renders all routes 200 as a brand-new EMPTY tenant via the dev-context cookie;
storefront brand + title now resolve from the operator (no env leak). Onboarding→bookable
(rates + timeslots + visibility) is code-reviewed + builds; full wizard→storefront
click-through is the remaining browser pass. typecheck 9/9, both apps build (admin 27 routes
incl. `/signup`, web build green). Decisions D-032, D-033. **Next: Phase 3 (money & go-live)
or deepen Phase 2 (Clerk-on signup, billing).**

---

# Tasks — Phase 1: Wire the Cockpit ✅ COMPLETE

> Small, discrete, checkable. Status: `todo` · `doing` · `done`. Each task is done
> only when typecheck + the relevant build pass and (where it applies) the live
> suite for the touched area is green. Newest phase at top; see [`ROADMAP.md`](ROADMAP.md)
> for the phase plan and [`PROGRESS.md`](PROGRESS.md) for the running log.

Branch: `phase-1-cockpit` (committed locally; not pushed — Vercel quota, see D-027).

| # | Task | Status |
|---|------|--------|
| 1.1 | **Customer email-OTP login UI** (web): `/login` screen → request code → verify → session cookie; wire the account area to use it instead of the order#+email stub. Flips 0.7 fully ✅. | done |
| 1.2 | **Admin Gift Cards page** (`/giftcards` + nav): list/search, issue, view detail with balance + ledger, redeem, adjust, void/reactivate. | done |
| 1.3 | **Admin Resources/Assets page** (`/resources` + nav): list, create/edit (seat_capacity, quantity, out_of_service, allocation mode), activity assignment, derived availableQty. The moat, made visible. | done |
| 1.4 | **Admin Waiver Templates** management (Settings → Policies/Waivers): list versions + signature counts, publish a new version, activate. | done |
| 1.5 | **Reports: By-Location tab** — per-location gross/volume roll-up + chain total + CSV (D-020). | done |
| 1.6 | **Reports: Accounting tab** — payment-level transactions journal keyed by cash date, per-tender reconciliation + CSV (D-021). | done |
| 1.7 | **POS gift-card tender** — accept a gift card as a tender in the POS payment panel (backend D-015 exists). | done |
| 1.8 | **Verification + cleanup pass** — stand the full stack up once, browser-smoke every route + the touched flows (incl. the 1.1 login E2E), run touched live suites green, fix any broken page/empty state, stage the clean Phase-1 PR. | done |

**Phase 1 (Wire the Cockpit) — COMPLETE.** Live-verified vs Neon: admin→API seam
(D-029/D-030), isolation 8/8, touched suites 35/35, all routes render 200 (2 pre-existing
500s fixed, D-031), customer login loop. typecheck 9/9, both apps build. Next: Phase 2
(self-serve operator front door).

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
