# The prompt

Paste this at the start of a fresh Claude Code session in
`C:\Users\dukot\projects\marina-booking-platform`. It works for the first session and
for every session after — it always resumes at the right place.

---

```
You are taking over the Marina Booking Platform and building it to completion.

Read docs/LOCAL-FIRST-BUILD.md first and treat it as binding. It is the operating
contract: the hard constraint, the verified facts about this machine, the competitive
bar, the definition of done, and the phase plan. Then read docs/NORTHSTAR-ROADMAP.md
for the competitive analysis and AGENTS.md for repo conventions.

The goal is a product that beats Singenuity and FareHarbor — good enough for the owner
to run Lake Sonoma Marina on, and good enough to sell to marinas paying those two today.

The constraint that shapes everything: the owner must be able to test 100% of this
product on his own laptop without creating an account with anyone. No Stripe, Neon,
Clerk, Resend, Twilio, Cloudflare, Sentry, or Docker. Every external dependency goes
behind an interface with a `local` driver and a `cloud` driver. Local drivers must be
faithful simulations of the real failure modes, never happy-path toys.

Work the phases in order. Find the first unchecked box in §12 of the contract and start
there. Phase 0 (the Local Sandbox) comes before any feature work — until it exists,
nothing else can be honestly tested.

Before you write code: confirm the current state yourself rather than trusting this
prompt. Start the WSL Postgres cluster, run the full test suite, and tell me what you
actually see.

Then plan the phase you are starting, tell me the plan in plain language, and build it.

Hold to the Definition of Done in §3 — especially: never tell me something works
unless you ran it and read the output. If you skip a check, say which one and why.
I would much rather hear "this part is unverified" than find out later.

Report back short and in plain language: what works now, what I can go click to see it,
and what is left. End with a TL;DR.

When you need a decision only I can make, ask. Otherwise use your judgment and keep
building.
```

---

## Making it multi-session

The prompt is deliberately resumable — it reads the contract, finds the first unchecked
phase, and continues. So the same paste works every time.

Between sessions, keep §12 of `LOCAL-FIRST-BUILD.md` honest. That checklist is the only
state that carries across sessions.

## How you will test, once Phase 0 lands

```
pnpm dev:local     # starts Postgres in WSL, api, web, admin — one command
pnpm verify        # typecheck + lint + every test + browser E2E
```

Then open the Local Console at `/dev` in the admin app. That is where you read the
emails and texts the system sent, force a card to get declined or throw a 3DS challenge,
jump the clock forward to fire reminders, replay webhooks, and reset to clean seed data.
No terminal, no accounts.
