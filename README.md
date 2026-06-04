# 🚤 Marina Booking Platform

> A modern, operator-first booking platform for marinas and outdoor recreation. Built to replace legacy tools like Singenuity with a fast, beautiful, white-label experience.

---

## 🎯 What This Is

This platform was reverse-engineered and vastly improved from **Singenuity** (booking software used by Lake Sonoma Marina). After a live audit of their system, we identified every pain point and designed a better product from the ground up.

**Live audit sources:**
- `register.singenuity.com` — operator register/manifest app
- `manage.singenuity.com` — admin dashboard
- `book.singenuity.com/758` — customer booking portal (Lake Sonoma Marina)

---

## 📁 Repository Structure

```
marina-booking-platform/
├── PRODUCT_REQUIREMENTS.md    # Full PRD: competitive analysis, data models, features, phases
├── README.md                  # This file — quick start for Claude Code
└── (coming soon)
    ├── apps/
    │   ├── web/               # Customer booking portal (Next.js)
    │   ├── admin/             # Operator dashboard + POS (Next.js)
    │   └── api/               # REST API + WebSocket (Hono/Fastify)
    ├── packages/
    │   ├── ui/                # Shared component library
    │   ├── database/          # Prisma schema + migrations
    │   ├── types/             # Shared TypeScript types
    │   └── emails/            # React Email templates
    └── turbo.json
```

---

## 🚀 Quick Start for Claude Code

Read `PRODUCT_REQUIREMENTS.md` first — it contains everything you need:

1. **Section 1** — Competitive analysis of Singenuity (what to beat)
2. **Section 2** — Full data models (TypeScript interfaces)
3. **Section 3** — Feature requirements (MVP → Power features)
4. **Section 4** — Design principles (8 things Singenuity gets wrong)
5. **Section 5** — Technical architecture + stack
6. **Section 6** — Implementation phases (24-week roadmap)
7. **Section 7** — Lake Sonoma Marina seed data (19 activities, pricing, policies)
8. **Section 8** — Success metrics

### Recommended Build Order

```bash
# Phase 1 — Start here
1. Monorepo setup (Turborepo)
2. Database schema (Prisma + PostgreSQL)
3. Auth (Clerk for operators)
4. Activity CRUD API
5. Customer booking portal (catalog → checkout)
6. Square payment integration
7. Email confirmations (Resend)
8. Operator day manifest view
```

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14+ (App Router), TypeScript, Tailwind CSS, shadcn/ui |
| Backend | Bun + Hono (or Node.js + Fastify) |
| Database | PostgreSQL via Prisma ORM |
| Cache | Redis |
| Jobs | BullMQ |
| Payments | Square SDK (primary), Stripe (alt) |
| Email | Resend + React Email |
| SMS | Twilio |
| Auth | Clerk (operators), magic link (customers) |
| Storage | Cloudflare R2 |
| Deploy | Vercel (frontend) + Railway (API) |

---

## 📊 Key Product Decisions

### One App, One Login
Singenuity splits admin and register into **2 separate applications** with different URLs, different sessions, different UX. We build everything as **one unified application** with role-filtered views.

### Dashboard First
Singenuity drops operators directly into a raw text manifest with no business overview. We open to a **dashboard** with revenue KPIs, occupancy heatmap, alerts, and upcoming bookings.

### Visual Manifest
Singenuity's day view is a **wall of text**. We build a **Gantt-style timeline** with color coding by activity, capacity bars, and one-click check-in.

### Full White-Label
Singenuity shows "Powered by Singenuity" on customer pages. We build **complete white-label** — operators' brand only.

### No 404s
Singenuity has **multiple broken pages** (reports, memberships, settings). We test every route.

---

## 🎯 Target Metrics

| Metric | Target |
|---|---|
| Booking conversion rate | >8% (vs industry 3-5%) |
| Page load LCP | <1.5s |
| Mobile booking rate | >60% |
| Admin task time | 50% faster than Singenuity |
| Operator onboarding | <2 hours |
| Broken page rate | 0% |

---

## 🌊 About Lake Sonoma Marina (Seed Client)

Lake Sonoma Marina (LSRA) operates 19 activities at Lake Sonoma, CA:
- **Pontoon boats** (5-person through double-decker 12-person) — $350–$700/half day
- **Watercraft** (jet skis, kayaks, paddle boards, canoes) — from $50/hr
- **Patio rentals** (7 venues, 20–100 people capacity) — $100/day

**Policies:** 21+ to operate boats, 30-min check-in, 9.25% sales tax, 4.00% processing fee

---

*Built from live competitive analysis — June 3, 2026*
