# Built Rite Marine — Website

A lean, mobile-first "business card" website for **Shannon Trent / Built Rite Marine**,
a boat mechanic serving Sonoma County, CA. Built as a self-contained **WordPress
theme** so it can be handed off and hosted on any standard WordPress site.

> **Status:** Design + structure complete with clearly-marked **placeholder
> content**. Real phone number and services need to be confirmed with Shannon
> before launch — see [Collect from Shannon](#collect-from-shannon). Nothing
> requires code edits; everything is editable in the WordPress Customizer.

Built by Copper Bay Tech.

---

## What's here

```
built-rite-marine/
├── preview.html                  ← generated standalone design preview (open in a browser)
└── theme/
    └── built-rite-marine/        ← the WordPress theme (this is what you install)
        ├── style.css             # theme header + all styles (navy/wood/brass)
        ├── functions.php         # setup, asset loading
        ├── front-page.php        # the one-page layout
        ├── header.php / footer.php
        ├── index.php             # fallback
        ├── inc/
        │   ├── helpers.php       # content defaults + accessors
        │   ├── customizer.php    # all editable content (Appearance → Customize)
        │   ├── schema.php        # LocalBusiness JSON-LD + Open Graph (SEO)
        │   └── contact-form.php  # native form handler (nonce + honeypot + wp_mail)
        ├── template-parts/
        │   ├── home.php          # Hero · Services · About · Area · Contact
        │   └── contact-form.php
        └── assets/js/            # mobile nav + customizer live preview
```

## Design

Rugged, honest, craftsman feel — **not corporate**:

- Deep navy hull tones, worn-wood browns, brass/rust accents, weathered bone text
- Industrial condensed display type (**Oswald**), system font for body (fast, no layout shift)
- **Mobile-first**, with click-to-call phone links everywhere (the core job of the site)
- One page, anchor-nav sections: **Hero → Services → About → Service Area → Contact**
- Loads fast and reads clean when reached via a **QR code on a business card**

---

## Preview

`preview.html` is a self-contained render of the front page (CSS + fonts
inlined) — open it in any browser to review the design without a WordPress
install. It's a generated reference only; the live site is driven by the theme,
so edit content in WordPress, not in this file.

## Install

1. **Zip the theme folder** (the inner `built-rite-marine` directory):
   ```bash
   cd built-rite-marine/theme
   zip -r built-rite-marine.zip built-rite-marine
   ```
2. In WordPress: **Appearance → Themes → Add New → Upload Theme**, choose the zip, **Activate**.
3. Set the homepage to the one-pager: **Settings → Reading → Your homepage displays → A static page**, or just leave it on the default — the theme renders the full layout on the front page either way.
4. Set the business name: **Settings → General → Site Title** = `Built Rite Marine`.
5. (Optional) Add a logo: **Appearance → Customize → Site Identity → Logo**, and a favicon under **Site Icon**.

> Local dev: drop the `built-rite-marine` folder into `wp-content/themes/` of a
> [Local](https://localwp.com/) / `wp-env` / Docker WordPress install and activate.

## Edit the content

All copy lives in **Appearance → Customize → "Built Rite Marine — Content"**, grouped into:

- **Phone & Contact** — phone number (powers click-to-call), email, hours
- **Hero** — kicker, tagline, trust-bar points
- **Services** — intro + the services list (`Title | Description`, one per line)
- **About Shannon** — heading, bio, signature, "Why Shannon" bullets
- **Service Area** — heading, intro, town list, note
- **Contact Section & Form** — heading/text, toggle the form, set the recipient email
- **Footer** — footer note

No theme files need editing for normal content changes.

### Contact form email (important for handoff)

The built-in form sends mail with WordPress's `wp_mail()`. On most hosts plain
`wp_mail()` is unreliable and lands in spam. Before launch, install an SMTP
plugin (e.g. **WP Mail SMTP**) and connect a real mailbox so submissions
actually arrive. Set the recipient under **Customize → Contact Section & Form →
Form recipient email**. Phone/text remains the primary call-to-action regardless.

---

## Collect from Shannon

The site ships with believable **placeholders** in these spots — confirm/replace each:

| Item | Where to set it | Current placeholder |
|------|-----------------|---------------------|
| **Phone number** (required) | Customize → Phone & Contact | `(707) XXX-XXXX` |
| Public email (optional) | Customize → Phone & Contact | _(blank)_ |
| Hours / availability | Customize → Phone & Contact | "By appointment — calls returned same day" |
| **Exact list of services** (required) | Customize → Services | 6 typical boat-mechanic services |
| Tagline | Customize → Hero | "Honest, old-school marine repair…" |
| About / bio details | Customize → About Shannon | Draft bio referencing Jordan Winery |
| Service-area towns | Customize → Service Area | Santa Rosa, Healdsburg, Windsor, … |
| Mobile vs. shop? | About / Service Area copy | Assumes mobile service |
| Form recipient email | Customize → Contact Section & Form | site admin email |

Suggested questions for Shannon:
- Best phone number for customers, and is **text** OK?
- What does he want to **take on** (and explicitly **not** take on)?
- Mobile-only (comes to the boat) or also a drop-off location?
- Any brands/engines he specializes in (Mercury, Yamaha, Volvo Penta, etc.)?
- A photo of him or his work for the About section?

---

## Business card / QR code

Point the QR code at the live domain (e.g. `https://builtritemarine.com`). The
hero loads phone-first so a scan → tap-to-call takes two taps. Test the QR at
small print size before ordering cards.

## Notes

- Self-contained theme, **no page builder, no required plugins** (SMTP recommended).
- Only external request is Google Fonts (Oswald). To go fully self-hosted, download
  Oswald into `assets/fonts/` and swap the `wp_enqueue_style( 'brm-fonts', … )`
  line in `functions.php` for a local `@font-face`.
- This project is independent of the `marina-booking-platform` app in the rest of
  this repository; it lives entirely under `built-rite-marine/`.
