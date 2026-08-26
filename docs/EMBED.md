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

If nothing appears, see Troubleshooting at the bottom.

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
MarinaBooking.version;                             // e.g. "1.0.0"
```

`MarinaBooking` is the only thing the script adds to your page. It does not
touch your cookies, your storage, your URL, or your styles.

---

## 7. Accessibility

The widget is built to be usable by keyboard and screen reader, because a booking
box that a customer cannot operate is a booking you do not get:

- The button announces itself as opening a dialog.
- The window is a real `dialog` with `aria-modal`, and keyboard focus is trapped
  inside it while it is open.
- `Esc` closes it, from inside the flow as well as from your page.
- Closing returns focus to the button that opened it.
- Tap targets are at least 44px on phones.
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
It shouldn't — the widget renders in a shadow root, so your site's CSS cannot
reach it and its CSS cannot reach your site. If your site is one of the rare ones
where that is unavailable, the widget falls back to its own `mbw-`-prefixed class
names, and a very aggressive global stylesheet (`button { ... !important }`) could
show through. Set `data-color` to at least keep the brand right.

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
