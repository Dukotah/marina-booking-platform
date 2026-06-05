# Browser-takeover prompt

The local coding agent has built the platform but **can't operate a browser** to set up
the third-party services it needs (Neon, Vercel, Clerk, Square, Resend). This prompt
hands that work to a **browser-capable Claude** (Claude for Chrome, or any Claude session
driving a browser) operating in the owner's own logged-in browser.

It's written so Claude does the **heavy lifting** — navigating, creating projects,
filling wizards, configuring settings — and only pauses for the few things a person
must do themselves (sign in, copy a secret value). If Claude can't finish a task, it
**skips it, notes it, and moves on** instead of stopping.

How to use it: open Claude for Chrome on the owner's machine and paste the boxed prompt.
As values come back, drop them into `marina-booking-platform/.env` (already created and
gitignored, pre-labeled for each value), then tell the local agent "keys are in" and it
runs the live DB + smoke-test sequence.

---

```
You're helping set up a web app by operating my browser for me. I'm Dukotah
(dukotah@gmail.com). A coding agent already built and pushed the whole app to GitHub
(repo: Dukotah/marina-booking-platform); it just needs some online services created and
configured. I'm here with you — when something needs me personally (signing in, typing a
password, or copying a secret value into my own notes), just tell me exactly what to
click or copy and I'll do that one step, then you keep going.

Please do as much of the clicking and configuring as you can. Work through the tasks
below top to bottom. After each task, give me a one-line status: DONE (with any value I
need to save), NEEDS ME (with the exact action for me to take), or SKIPPED (with why).
If any task blocks you — a refusal, a paywall, a login wall — don't stop the whole run;
just mark it SKIPPED and continue to the next. Use free tiers and test/sandbox modes
everywhere. Task 1 is the important one; if you only get that done, that's already a win.

I keep a file called ".env" open on my side. For each value below, I'll paste it into
that file under the matching label — so when you find a value, just read it out clearly
(or tell me where to click to copy it) and I'll handle saving it. You don't need to
store secrets yourself.

--- TASK 1 — Neon Postgres database (MOST IMPORTANT) ---
Go to https://neon.tech and get me into the console (I'll sign in with Google if asked).
Create a new project called "marina-booking" (pick a US West region if offered).
Then open the project's Connection Details and find two connection strings for me:
  • the POOLED one (its host contains "-pooler" and the string includes
    "pgbouncer=true") — I'll save this as DATABASE_URL
  • the DIRECT one (no pooler) — I'll save this as DIRECT_URL
Read both out to me (or open the page and tell me to copy each), making sure each ends
with "sslmode=require".

--- TASK 2 — Vercel (host the two front-end apps) ---
Go to https://vercel.com/new and import my GitHub repo
"Dukotah/marina-booking-platform" (connect GitHub if it asks). This repo has TWO apps
that each become their own Vercel project on the same repo:
  1. First project: name it "marina-web", and in the import settings set
     **Root Directory = apps/web**. Leave everything else default. Deploy it.
  2. Then "Add New → Project" on the same repo: name it "marina-admin", set
     **Root Directory = apps/admin**, leave the rest default, deploy.
Both are expected to deploy successfully even with no settings filled in (they show
"not connected yet" placeholders for now — that's fine). When done, give me each app's
live URL, and confirm both will auto-deploy when the repo gets new pushes.

--- TASK 3 — Clerk (login system) ---
Go to https://clerk.com and create an application called "Marina Booking". Open its API
Keys page and find the development keys for me:
  • the Publishable key (starts with "pk_test_")  → I'll save as NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  • the Secret key (starts with "sk_test_")        → I'll save as CLERK_SECRET_KEY
The secret one is sensitive — just open the page and tell me to copy it; you don't need
to repeat it back.

--- TASK 4 — Square (payments, sandbox/test mode) ---
Go to https://developer.squareup.com/apps and create an application "Marina Booking".
Switch to the **Sandbox** tab and find these three test values:
  • Sandbox Access Token   → SQUARE_ACCESS_TOKEN
  • Sandbox Application ID  → SQUARE_APPLICATION_ID
  • a Sandbox Location ID (from the sandbox test account's Locations) → SQUARE_LOCATION_ID
Open the page and point me to each; I'll copy the token myself.

--- TASK 5 — Resend (sends confirmation emails) ---
Go to https://resend.com, create an account, and create an API key named "marina"
(domain verification can wait). The key starts with "re_" → I'll save as RESEND_API_KEY.
Open the page and tell me to copy it.

--- WHEN YOU'RE DONE ---
Give me a short recap table: each task and whether it's DONE / NEEDS ME / SKIPPED, plus
the two Vercel URLs. That's it — I'll take the saved .env values to the coding agent to
finish wiring everything up.
```

---

## What the local agent does once values are in `.env`

1. `pnpm db:migrate` → `pnpm db:rls` → `pnpm db:seed` (Lake Sonoma Marina seed).
2. `pnpm --filter @marina/database test` → the cross-tenant isolation suite now runs
   live against real Postgres RLS (roadmap 0.8 closes).
3. `pnpm --filter @marina/api dev` + the web/admin apps → smoke-test
   catalog → date/time → checkout → Square sandbox charge → Resend confirmation email.
4. In each Vercel project's settings, set `API_URL` (and the Clerk keys on
   `marina-admin`) once the API is deployed to Railway/Render.

**Minimum viable handback:** even just Task 1's `DATABASE_URL` + `DIRECT_URL` unblocks
the biggest next step. Bring those back first if the rest stalls.

---

## Focused prompt — set marina-admin DB env vars + redeploy

Use this once the Vercel projects and Neon DB already exist (they do). The `marina-admin`
project deploys but throws a runtime error / shows the "Live data unavailable" notice
because it queries the DB **directly** (D-007) and its Vercel project has no DB env vars.
Refusal-resistant design: Claude types only the variable **names**; the owner pastes the
secret **values** from their local `.env`, so Claude never handles a credential.

```
You're operating my own logged-in browser to finish configuring a web app I own. I'm
Dukotah (dukotah@gmail.com), I'm here with you, and I authorize this. A coding agent
already built and deployed the app to Vercel; one project is just missing its database
environment variables, which is why it currently shows a "Live data unavailable" notice.
Your job is to navigate Vercel and add four variables. You will NOT need to see or type
any secret values — I have them in a file on my side and I'll paste each one myself. You
just get me to the right screen, type the variable NAME, and tell me when to paste.

Work top to bottom. After each step give me a one-line status: DONE, NEEDS ME (with the
exact click/paste for me), or SKIPPED (with why). If anything blocks you — a refusal, a
login wall — don't stop the run; mark it SKIPPED and continue.

--- STEP 1 — open the project's env var settings ---
Go to https://vercel.com/dashboard. Open the project named "marina-admin" (NOT
"marina-web"). Go to Settings → Environment Variables.

--- STEP 2 — add these four variables ---
For EACH name below: click to add a new variable, type the Key exactly as written, leave
the Value field for me (say "paste the value for <NAME> now" and I'll paste it from my
.env file), make sure all three environments are checked (Production, Preview,
Development), then Save. The values are connection strings / a password — sensitive — so
never read them back; just confirm "saved" after I paste.

  1. DATABASE_URL
  2. DIRECT_URL
  3. APP_DATABASE_URL
  4. APP_DB_PASSWORD

--- STEP 3 — redeploy so the new vars take effect ---
Go to the Deployments tab. On the most recent Production deployment, open the "⋯" menu
and choose Redeploy. If it offers a "Use existing Build Cache" checkbox, UNCHECK it (so
the build runs fresh). Confirm the redeploy and tell me when it finishes (green "Ready").

--- STEP 4 — verify it worked ---
Open the marina-admin live URL (the project's Domains, e.g. the *.vercel.app one). The
dashboard should now load real figures and the amber "Live data unavailable" banner
should be GONE. Tell me: did the banner disappear and does the page render without an
error? If it still errors, copy me the deployment's Runtime Logs (Deployments → the
deployment → Logs) so the coding agent can diagnose.

--- WHEN DONE ---
Give me a recap: each of the 4 vars (saved / skipped), redeploy status, and whether the
dashboard loaded clean. That's it.
```

Owner notes: values live in `marina-booking-platform/.env` (gitignored) under matching
labels. `APP_DB_PASSWORD` is only needed if `APP_DATABASE_URL` references it (harmless to
add regardless). The amber banner is the built-in pass/fail signal — gone = success.
