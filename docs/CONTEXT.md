# Context — What We're Building and Why

## Mission

Build a modern, beautiful, blazing-fast, **multi-tenant SaaS booking platform** for
marinas and outdoor-recreation operators that is dramatically better than the legacy
incumbent (Singenuity) — solid enough to sell to real paying customers.

## The problem

Marina/recreation operators are stuck on clunky legacy booking software. The
reference incumbent, **Singenuity** (used by Lake Sonoma Marina), was audited live.
It splits into 3 separate apps with separate logins, dumps operators into a text-wall
manifest with no dashboard, has broken/404 pages throughout, shows "Powered by
Singenuity" branding on customer pages, and offers no visual scheduling. Full
teardown is in [`../PRODUCT_REQUIREMENTS.md`](../PRODUCT_REQUIREMENTS.md) § 1.

## What makes us better (the wedge)

| Singenuity | Us |
|---|---|
| 3 separate apps, 3 logins | One app, one login, role-filtered views |
| No dashboard — dumps to manifest | Dashboard-first with revenue/occupancy KPIs |
| Text-wall manifest | Visual Gantt manifest, color-coded, drag-to-reschedule |
| Broken 404 pages everywhere | Zero broken pages, tested routing |
| "Powered by Singenuity" branding | Full white-label — operator's brand only |
| 18+ settings pages, no search | Guided setup wizards, grouped settings |
| No availability signal on catalog | Color-coded availability per activity/slot |

## Who we sell to

**Seed client (customer zero): Lake Sonoma Marina** — operated by the project owner.
We use it to battle-test the product in the real world. 19 activities (pontoons,
watercraft, patios). Full seed data in the PRD § 7.

**Target growth customers — and the reason we build multi-tenant from day one.**
We are deliberately architecting for operators *more complex than our own marina*:

1. **Multi-location / chains** — operators running several marinas/sites under one
   account, needing per-location dashboards and roll-up reporting.
2. **More activity verticals** — beyond boats/patios: lodging, equipment rental,
   guided tours, classes, memberships, events. The data model must not hard-code
   "boat."
3. **Bigger operations** — many staff with granular roles/permissions, shift &
   guide scheduling, higher booking volume.
4. **Channel & integrations** — OTAs/affiliates, accounting (QuickBooks/Xero),
   CRM, marketing pixels, SMS.

These four requirements drive the core architecture decisions (see
[`DECISIONS.md`](DECISIONS.md)).

## Business model

White-label SaaS. Each operator is a **tenant** with isolated data, their own
branding, custom domain/subdomain, and (eventually) per-tenant billing. Likely
revenue: subscription + payment-processing margin. The platform must look like
*the operator's* product, never ours, to the end customer.

## Definition of "rock solid" (the bar before we sell)

- **Tenant isolation is provably airtight** — operator A can never see operator B's
  data, even via crafted requests.
- **Money works correctly** — payments, refunds (full + partial), failed cards,
  chargebacks, reconciliation. Tested.
- **Waivers are legally sound** — captured signatures, minor handling, audit trail.
- **Zero broken routes**, graceful error handling, sensible empty states.
- **Auth, backups, and observability** are in place.

## Success metrics (targets)

| Metric | Target |
|---|---|
| Booking conversion rate | >8% (industry 3–5%) |
| Page load LCP | <1.5s |
| Mobile booking rate | >60% |
| Admin task time vs Singenuity | 50% faster |
| Operator onboarding | <2 hours |
| Broken page rate | 0% |

## Glossary

- **Operator / Tenant** — a business using the platform (e.g. a marina). Top-level
  isolation boundary. Carries branding, settings, staff, locations.
- **Location** — a physical site belonging to an operator. Operators may have many.
- **Activity** — a bookable offering (a pontoon rental, a patio, a tour, a room).
- **Rate** — a priced duration/option for an activity (Half Day $350, etc.).
- **Timeslot** — a bookable datetime with capacity for an activity.
- **Order** — a customer's booking transaction (one or more order items).
- **Customer / Guest** — the end user who books. Belongs to an operator.
