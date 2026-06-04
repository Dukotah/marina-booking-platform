# AGENTS — READ THIS FIRST

You are an AI agent working on the **Marina Booking Platform**. Before writing any
code, read these docs in order. They are the shared brain for this project — every
decision, constraint, and goal lives here so any agent can pick up the work and
understand *why*, not just *what*.

| # | Doc | What it tells you |
|---|---|---|
| 1 | [`docs/CONTEXT.md`](docs/CONTEXT.md) | The mission, who we're beating, who we sell to, the business model |
| 2 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the system is built — multi-tenancy, stack, data model, dev environment |
| 3 | [`docs/DECISIONS.md`](docs/DECISIONS.md) | Append-only log of every significant decision and its rationale |
| 4 | [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases + a live status board of what's done / in progress / next |
| 5 | [`PRODUCT_REQUIREMENTS.md`](PRODUCT_REQUIREMENTS.md) | The full PRD — competitive analysis, features, seed data |

## Working rules for agents

1. **The repo is the source of truth.** If we decide something in conversation,
   it gets written into `docs/` — otherwise it didn't happen.
2. **Multi-tenant always.** Every table has `operator_id`. Every query is scoped.
   Never write code that could leak one operator's data to another. See
   `docs/ARCHITECTURE.md` § Tenant Isolation.
3. **Rock-solid over fast-and-loose.** This product handles real bookings and real
   money. Validate inputs, handle payment edge cases, write tests for anything
   touching money, waivers, or tenant boundaries.
4. **Budget-aware.** The owner is on a limited plan. Build incrementally in small
   vertical slices. Don't spawn large agent swarms. Prefer direct, lean work.
5. **Update the docs as you go.** When you finish a slice, update
   `docs/ROADMAP.md`. When you make a call, append to `docs/DECISIONS.md`.

## Project owner

Dukotah (operates Lake Sonoma Marina, the seed client). Wants a fully built,
sellable product with minimal manual input. Decisions should default to sensible,
documented choices rather than blocking on questions.
