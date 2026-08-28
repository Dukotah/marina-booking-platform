# Put booking on your own website

This is the booking widget. You paste one line into your website and customers can
book you without ever leaving your page — same live availability, same checkout,
same confirmation email as your main booking site.

You do not need a developer for the basic install. If you can edit your site's
HTML or paste a "custom code" block, you can do this in about two minutes.

---

## 1. The snippet

Paste this wherever you want booking to appear:

```html
<script src="https://book.yourmarina.com/embed.js" data-operator="your-slug"></script>
```

Replace `book.yourmarina.com` with your own booking address (the one in your
browser bar when you use your booking site), and `your-slug` with your operator
slug. If you do not know your slug, ask us — but on your own booking domain the
widget already knows who you are, so `data-operator` is only a safety net.

By default this shows a **Book now** button. Clicking it opens the whole booking
flow in a window over your page. On a phone that window is full screen.

That is the entire install. Everything below is optional.

---

## 2. The four ways to show it

Set `data-mode` to pick one.

| `data-mode` | What the visitor sees | Use it when |
|---|---|---|
| `button` (default) | A **Book now** button, sitting where you pasted the script | Most pages |
| `inline` | The booking flow itself, embedded in the page, growing to fit | A dedicated "Book" or "Rentals" page |
| `floating` | A button pinned to the bottom corner of every screen | You want booking reachable from anywhere on the page |
| `manual` | Nothing, until your own button calls it | You already have a "Book now" button you like |

**Inline** wants a place to live. Either drop the script exactly where the flow
should appear, or point it at an element you already have:

```html
<div id="booking"></div>
<script src="https://book.yourmarina.com/embed.js"
        data-operator="your-slug"
        data-mode="inline"
        data-target="#booking"></script>
```

**Manual** means you wire your own button:

```html
<button onclick="MarinaBooking.open()">Reserve a boat</button>
<script src="https://book.yourmarina.com/embed.js"
        data-operator="your-slug"
        data-mode="manual"></script>
```

---

## 3. Every setting

All of these go on the `<script>` tag.

| Attribute | Default | What it does |
|---|---|---|
| `data-operator` | *(from the address)* | Your operator slug. On your own booking domain this is already known; set it if you host the widget somewhere shared. |
| `data-activity` | *(none)* | Skip the list and open one specific activity. Great for a page about that one boat. The "all activities" link is hidden, so the customer never lands somewhere you did not send them. |
| `data-mode` | `button` (`inline` if `data-target` is set) | `button`, `inline`, `floating`, or `manual`. See above. |
| `data-target` | *(none)* | CSS selector of the element to render into, e.g. `#booking` or `.booking-slot`. Only used by `inline`. |
| `data-label` | `Book now` | The text on the button. |
| `data-color` | *(your brand color)* | Accent color as a hex code, e.g. `#0369a1`. Colors the button and the widget to match your site. Must be a hex code — anything else is ignored. |
| `data-position` | `bottom-right` | `bottom-right` or `bottom-left`. Only used by `floating`. |
| `data-height` | `720` | Starting height in pixels for `inline`, before the widget measures itself. Just a first guess — it corrects itself immediately. |
| `data-open` | `false` | Set to `true` to open the booking window as soon as the page loads. Use sparingly. |
| `data-title` | `Book online` | The window's accessible name, read aloud by screen readers. |
| `data-base` | *(where embed.js came from)* | Override the booking address. You will not normally need this. |

### A worked example

One activity, inline, on a page about your 22ft pontoon:

```html
<script src="https://book.yourmarina.com/embed.js"
        data-operator="lake-sonoma"
        data-activity="pontoon-22"
        data-mode="inline"
        data-target="#pontoon-booking"
        data-color="#0369a1"></script>
```

---

## 4. Where to paste it

- **WordPress** — add a "Custom HTML" block, paste, publish. Do not use the
  visual editor's paragraph block; it will mangle the tag.
- **Squarespace** — add a "Code" block and paste. For the floating button, use
  Settings → Advanced → Code Injection → Footer instead, so it appears sitewide.
- **Wix** — Add → Embed Code → Embed HTML, paste, then drag the box to size.
  Inline mode needs the box tall enough to start with; it grows on its own.
- **Webflow / Framer / plain HTML** — an embed / custom code element, or straight
  into the page source.
- **Shopify** — a "Custom Liquid" section.

Two widgets on the same page is fine. So is the same script tag on every page of
your site.

---

## 5. Checking that it worked

1. Load the page in a normal browser window (not a preview pane — some site
   builders block scripts in preview).
2. Click the button. You should see the real activity list, real dates, real
   prices.
3. On your phone, the window should fill the screen and the buttons should be
   easy to tap.
4. Press `Esc`. The window should close and put you back on the button you
   clicked.
5. Scroll-test it: open the booking window and try to scroll. **Your page behind
   should not move.** Then close it and scroll again — it should scroll normally,
   from exactly where you left it.
6. Look at the corners. If you have a chat bubble, a cookie bar or a "back to
   top" button, none of them should sit on top of the booking window.

Steps 5 and 6 are there because they are the two things that used to break on
real sites. See Troubleshooting if either one does.

If nothing appears at all, see Troubleshooting at the bottom.

---

## 6. Tracking bookings in your own analytics

The widget tells your page when a booking completes, so it can count in Google
Analytics, Meta Ads, or anything else. Three ways to catch it — use whichever
your setup already speaks.

**Google Tag Manager.** Nothing to install. The widget pushes to `dataLayer`:

```json
{
  "event": "marina_booking_completed",
  "orderNumber": "MB-2K4H9",
  "totalCents": 24500,
  "currency": "USD",
  "guests": 4,
  "activityIds": ["pontoon-22"],
  "activityNames": ["22ft Pontoon"]
}
```

Create a Custom Event trigger on `marina_booking_completed` and use
`totalCents / 100` as the conversion value.

**A browser event**, if you write your own JavaScript:

```html
<script>
  window.addEventListener('marina:booking', function (e) {
    gtag('event', 'purchase', {
      transaction_id: e.detail.orderNumber,
      value: e.detail.totalCents / 100,
      currency: 'USD',
    });
  });
</script>
```

**The widget's own API**, which also gives you the earlier steps:

```html
<script>
  MarinaBooking.on('booking', function (b) { console.log('booked', b.orderNumber); });
  MarinaBooking.on('step', function (s) { console.log('customer is on', s.step); });
</script>
```

Money is always in whole cents — `24500` means $245.00. Never divide it twice.

### Events you can listen for

| Event | Fires when | You get |
|---|---|---|
| `open` | The booking window opens | `{ id }` |
| `ready` | The flow has loaded and is usable | `{ id, step }` |
| `step` | The customer moves through the flow | `{ id, step, activityId }` — step is `catalog`, `activity`, `checkout`, or `confirmation` |
| `resize` | The flow's height changes | `{ id, height }` |
| `booking` | A booking is paid for and confirmed | the payload shown above |
| `navigate` | The customer asked for a page that is not part of booking (e.g. your terms) | `{ id, url }` — the widget opens it in a new tab so their booking is not lost |
| `close` | The window closes | `{ id, reason }` |
| `error` | The flow could not load; a plain link is shown instead | `{ id, reason, url }` |

### Controlling it from your own code

```js
MarinaBooking.open();                              // open the booking window
MarinaBooking.open({ activity: 'pontoon-22' });     // open straight to one activity
MarinaBooking.close();                             // close it
MarinaBooking.mount('#booking');                   // render the flow inline, from code
MarinaBooking.on(event, fn) / .off(event, fn);     // subscribe / unsubscribe
MarinaBooking.destroy();                           // remove every widget on the page
MarinaBooking.version;                             // e.g. "1.1.0"
```

`MarinaBooking` is the only thing the script adds to your page. It does not touch
your cookies, your storage or your URL, and it adds no stylesheet to your site.

The one thing it does change, and only while the booking window is open, is that
it holds your page still (it sets `overflow: hidden` on `<html>` and `<body>`, and
puts back exactly what was there when the window closes, scroll position and all).
That is what stops the page sliding around behind the window on a trackpad.

---

## 7. Accessibility

The widget is built to be usable by keyboard and screen reader, because a booking
box that a customer cannot operate is a booking you do not get:

- The button announces itself as opening a dialog.
- The window is a real `dialog` with `aria-modal`, and keyboard focus is trapped
  inside it while it is open — in **both** directions. Tab past the end wraps to
  the close button; Shift+Tab off the start wraps back into the booking flow.
  (Because the flow runs in a frame, wrapping backwards lands at the top of the
  flow rather than on its last field. That is a limitation of frames, not a bug.)
- `Esc` closes it, from inside the flow as well as from your page.
- Closing returns focus to the button that opened it.
- Tap targets are at least 44px on phones, and the **Book now** button goes full
  width below 640px so it is easy to hit.
- Animations are cut when the visitor has "reduce motion" turned on.

---

## 8. Troubleshooting

**Nothing appears.**
Your site builder may strip `<script>` tags from ordinary content. Use its
dedicated code/embed block, or its footer code injection. View the page in a real
browser tab, not the builder's preview.

**"The booking window did not load."**
That message replaces the spinner if the flow cannot reach us within 15 seconds,
and it offers a plain link so you never lose the customer. Usually it means an ad
blocker or a corporate network is blocking the frame, or the booking address in
`src=` is wrong.

**The inline widget is cut off or has its own scrollbar.**
It measures itself and reports its height continuously, so this should not
happen. If it does, check that your page is not forcing a fixed height on the
element you targeted (`height: 400px; overflow: hidden`). Use `min-height`
instead, or nothing at all.

**The button looks wrong.**
It shouldn't. The widget renders in a shadow root, so your site's CSS cannot reach
inside it and its CSS cannot reach your site — a global `button { ... !important }`
rule, a font, a text-transform, none of it crosses. This is tested against a mock
site whose stylesheet is deliberately as aggressive as we could make it.

Two real exceptions:

- If your browser is old enough to have no shadow DOM, the widget falls back to
  its own `mbw-`-prefixed class names, and a very aggressive global stylesheet
  could show through. Set `data-color` to at least keep the brand right.
- CSS variables are the one thing that does cross the boundary. If your site
  happens to define custom properties called `--mbw-accent` or `--mbw-h`, rename
  them; the widget defends against both, but nothing good comes of the collision.

**The booking window appears at the bottom of the page instead of over it, and
the page jumps.**
Fixed in loader **1.1.0**. Some themes apply `transform: translateZ(0)` to every
top-level element as a speed trick; under CSS rules that makes the theme's element
— not the screen — the reference box for anything positioned over the page, so the
booking window was laid out inside it and the page grew by the window's height.
The loader now pins its own container against that. Check
`MarinaBooking.version` in your browser console; if it is not at least `1.1.0`,
hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R) to clear the cached script.

**Your chat bubble or cookie bar sits on top of the booking window.**
Also fixed in 1.1.0. The window now sits at the highest layer a browser allows,
and re-claims the top of the stack every time it opens — which matters because
chat widgets are usually injected after the page has loaded, i.e. after us. If
something still covers it, that thing is inside a container of its own that the
browser is treating as a separate layer; tell us what it is and we will look.

**The page behind scrolls while the booking window is open.**
Also fixed in 1.1.0. If your theme uses `html { overflow-x: hidden }` — a very
common fix for an accidental sideways scrollbar — then locking the page body has
no effect, so the loader now locks both. Your scroll position is restored exactly
when the window closes.

**The booking window is cut off at the bottom and I cannot scroll it.**
Fixed in 1.1.0. On a tall booking (a long checkout, or a phone) the window is
capped at the height of the screen, and the flow inside now scrolls. Before 1.1.0
the inside scrollbar was suppressed, so anything past the bottom edge was
unreachable.

**It works on desktop but not on an old iPad.**
The loader is deliberately plain JavaScript with no dependencies, so it runs on
old browsers. The booking flow itself needs a browser from roughly 2019 onward.

---

## 9. Notes for whoever runs the platform

*Operators can stop reading here.*

- **What the snippet loads.** `apps/web/public/embed.js` is the loader; it frames
  `/embed` on the same origin. The whole funnel lives on that one route and moves
  by query string (`components/embed/params.ts`), which keeps the layout — and
  therefore the resize/postMessage bridge — mounted for the entire booking.
- **No forked booking logic.** The activity step renders the portal's real
  `BookingWidget`; the checkout step renders the portal's real checkout page
  component, validation and all. `EmbedRouterProvider` overrides Next's
  `AppRouterContext` so those components' links and `router.push` calls resolve to
  `/embed?step=…` instead of navigating the iframe to the full-chrome routes.
- **Tenant resolution.** Canonically the request host — an operator installs the
  widget from their own booking domain, and the API's tenant middleware resolves
  it server-side. `data-operator` additionally sets the `operator_slug` cookie for
  browser-side catalog/availability calls; third-party cookie blocking can drop
  it, which is why it is a hint and not the mechanism.
- **Framing headers.** Nothing in this app sets `X-Frame-Options`, so `/embed` is
  framable today. To restrict it to operator-approved domains, add a `headers()`
  entry in `apps/web/next.config.mjs` for `source: '/embed'` setting
  `Content-Security-Policy: frame-ancestors <domains>` — and set it per tenant
  from the operator record, not globally, or one operator's allowlist blocks
  everybody else's. Do **not** add a blanket `X-Frame-Options: DENY` to the app
  without exempting `/embed`; it would silently break every install.
- **Protocol.** `marina-embed`, version 1, defined in
  `apps/web/components/embed/protocol.ts` and mirrored in the loader. The host
  validates `event.source === iframe.contentWindow` **and** `event.origin`; the
  frame addresses the host by the origin it learns in the handshake. Bump `v` on
  both sides together — a stale cached loader is then ignored rather than
  half-honoured.
- **The `booking-completed` payload is money.** It is integer cents, and it is
  emitted once per order (guarded by `sessionStorage`). Operators will build
  ad-spend decisions on it.

### Surviving a hostile host page

`e2e/specs/embed.spec.ts` loads the loader onto `e2e/fixtures/host-page.html` — a
mock marina site with a global reset, tag selectors on `div`/`button`/`iframe`,
`html { overflow-x: hidden }`, `body > div { transform: translateZ(0) }`, colliding
CSS custom properties, a stale `window.MarinaBooking`, a `message` listener that
throws, and a chat bubble at int32-max z-index injected after load. The fixture is
served from a real `node:http` server on `127.0.0.1`, which is a genuinely
different origin from `localhost:3000`, so postMessage and origin pinning are
exercised for real rather than simulated.

The first time it ran, six of ten checks failed. What it found, and the rules that
came out of it — none of these are obvious from reading the loader on its own:

- **A shadow root protects the inside, not the host element.** The host `<div>` is
  in the operator's light DOM, so their `div { … }` rules match it — and CSS
  scoping gives an outer-tree *normal* declaration the win over an inner-tree
  `:host` one, so `:host { all: initial }` is not the shield it looks like. The
  only declaration the page cannot outrank is a `!important` **style attribute** on
  that element, which is what `HOST_GUARDS` / `harden()` writes. Losing this is not
  cosmetic: with `body > div { transform: translateZ(0) }` on the page, the fixed
  overlay took that div as its containing block, rendered as a 3400px box at the
  bottom of the document, and scrolled the page 2100px to reach it.
- **z-index 2147483647 or nothing.** int32 max is where browsers clamp, so it can
  only be tied, never beaten — and a tie is settled by document order. Chat
  widgets and consent gates are injected by tag managers *after* we mount, so
  `open()` re-appends the modal's host element to `<body>` every time.
- **Locking `<body>` is not a scroll lock.** Body overflow only propagates to the
  viewport while `<html>`'s own overflow is `visible`, and `html { overflow-x:
  hidden }` removes that. Both elements are locked, and both inline values are
  restored verbatim.
- **`scrolling="no"` belongs to inline mode only.** Inline grows to the reported
  height so it never needs a scrollbar. A modal is capped at 92vh, so suppressing
  its scrollbar made everything past the cap unreachable — on the seeded tenant the
  catalog alone reports 3884px into an 828px dialog.
- **A focus trap needs a sentinel at *both* ends.** The start sentinel sat after
  the close button, so Shift+Tab off the close button walked onto the host page.
- **`all: initial` does not reset custom properties.** A host `--mbw-accent` or
  `--mbw-h` inherits straight through the boundary; `.mbw-root` re-declares both,
  using `--mbw-h: initial` (the guaranteed-invalid value) so `var(--mbw-h, 560px)`
  falls back to ours.
- **`width: 100%` on a shrink-to-fit host is a no-op.** The button launcher's host
  is `inline-block` to stay in the operator's text flow, which silently made the
  stylesheet's phone rule do nothing. The host's display now tracks the same
  breakpoint through `matchMedia`, because a style attribute cannot carry a media
  query.

Things that held up unchanged on first contact: shadow-root style isolation in
both directions for everything except custom properties, taking over a stale
`window.MarinaBooking`, the origin-pinned handshake, `Esc` and focus restoration,
inline mode's grow-to-fit, and the `data-activity` deep link.
