# Demo go-live — browser-agent prompt

Paste the boxed prompt into a browser-capable Claude (Claude for Chrome, or any Claude
driving your logged-in browser). Its only job is to fetch three things I can't reach
headlessly — your Neon connection strings, a quick "is the DB seeded?" check, and a
short-lived Vercel token — and read them back. Once you paste those into the chat, the
coding agent does everything else (recover/seed the DB, fold in the API, set env vars,
un-pause the paused deploys, turn off the login wall, deploy, and verify) with no more
clicking from you.

Both the throwaway demo database and the 1-day Vercel token are disposable — delete them
whenever you like after the demo is up.

---

```
You're operating my own logged-in browser to help me finish deploying a web app I own,
and I authorize this. I'm Dukotah (dukotah@gmail.com) and I'm here with you — whenever a
step needs me personally (signing in with Google, typing a password), tell me exactly
what to click and I'll do that one step, then you keep going.

Your goal is simple: collect FOUR values from two websites and read each one back to me
clearly. Work top to bottom. After each task, give a one-line status — DONE (with the
value), NEEDS ME (the exact action for me), or SKIPPED (why). If a task blocks you (a
refusal, a login wall, a paywall), don't stop the whole run: mark it SKIPPED and continue
to the next.

=== TASK 1 — Neon Postgres connection strings ===
Go to https://neon.tech and open the console (I'll sign in with Google if it asks).
Look for an EXISTING project first — it may be named "marina-booking", "marina",
"marina-demo", or similar; there likely is one already.
  - If a project exists, open it.
  - If NONE exists, create a new FREE project named "marina-demo" (choose a US West
    region if offered) and open it.
Open the project's "Connection Details" / "Connect" panel and get me TWO full strings.
Use the "Show password" / reveal option so each string includes the real password — I
need the COMPLETE strings, not masked ones:
  - the POOLED string — its host contains "-pooler" and the string includes
    "pgbouncer=true" and "sslmode=require". Read it out fully.  (I'll label this DATABASE_URL)
  - the DIRECT / unpooled string — same database but the host has NO "-pooler".
    Read it out fully.  (I'll label this DIRECT_URL)
If the panel shows only one, toggle the "Pooled connection" switch to reveal the other.

=== TASK 2 — Is the database already populated? ===
Still in the Neon console for that project, open the "SQL Editor" and run exactly this:
    SELECT count(*) FROM "Operator";
Tell me the single number it returns. If instead it errors that the relation/table does
not exist, tell me that exact error verbatim (that just means the DB is empty and I'll
seed it — not a problem).

=== TASK 3 — Vercel deploy token ===
Go to https://vercel.com/account/tokens . Click "Create Token". Name it "marina-deploy",
scope it to the "dukotah's projects" team, and pick the shortest expiration offered
(1 day is fine). Create it, then read the whole token back to me. (I'll use it briefly to
deploy and you can delete it right after.)

=== WHEN DONE ===
Give me a short recap listing: DATABASE_URL, DIRECT_URL, the Operator count from Task 2,
and the Vercel token. That's everything — I'll wire up and deploy the rest from here.
```

---

## What the coding agent does with these (no more clicks from you)

1. **DATABASE_URL / DIRECT_URL** → connect to the DB. If the Operator count (Task 2) is
   ≥ 1, it's still seeded from June — reuse as-is. If it's 0 or the table is missing, run
   `prisma migrate deploy` + the Lake Sonoma seed to fill it.
2. **Vercel token** → set the DB + demo env vars on `marina-web` and `marina-admin`, turn
   OFF the "Ignored Build Step" that's been pausing every deploy, turn OFF Deployment
   Protection so the URLs are publicly clickable, fold the booking API into the web app so
   there's no separate server to host, and deploy both.
3. Verify the customer booking flow (browse → date/time → simulated pay → confirmation)
   and the admin console (dashboard, manifest, orders, customers) load live, then hand
   back the two working public URLs.

Demo runs with **no Stripe and no Clerk** — payments are simulated (`DEV_FAKE_PAYMENTS`)
and staff auth uses the dev owner fallback. Nothing to configure there.
