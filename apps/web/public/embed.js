/*!
 * Marina Booking — embeddable booking widget loader.
 *
 * One <script> tag on the operator's own website turns into a real booking flow:
 * either an inline booking panel or a launcher button that opens a modal overlay.
 * The flow itself runs in an iframe pointed at this deployment's /embed route, so
 * the operator's page never loads our CSS, our React, or our cookies.
 *
 *   <script src="https://book.example.com/embed.js"
 *           data-operator="lake-sonoma"
 *           data-activity="optional-activity-id"></script>
 *
 * Constraints this file holds itself to, because it runs on somebody else's site:
 *   - Zero dependencies. No jQuery, no React, no assumptions about the host page.
 *   - Exactly one global: window.MarinaBooking.
 *   - All markup lives inside a shadow root, so host CSS cannot reach in and our
 *     CSS cannot leak out. (Plain-DOM fallback for browsers without shadow DOM
 *     uses the same `mbw-`-prefixed class names.)
 *   - ES5 syntax on purpose: a syntax error in a third-party script takes the
 *     whole host page's script down with it, so this parses everywhere.
 *   - Nothing is written to the host's cookies, storage, or history.
 *
 * Communication with the iframe is a small versioned postMessage protocol —
 * see docs/EMBED.md for the full contract.
 */
(function (window, document) {
  'use strict';

  if (!window || !document) return;

  var NAMESPACE = 'MarinaBooking';
  var VERSION = '1.1.0';
  var PROTOCOL = 'marina-embed';
  var PROTOCOL_VERSION = 1;

  /* 2147483647 is int32 max, which is where every browser clamps z-index. Nothing on
     the host page can legally outrank it — a cookie banner or a chat bubble can only
     TIE, and a tie is decided by document order, which is why `open()` re-appends the
     overlay's host element to <body> every time. A smaller "polite" value is not
     politeness, it is losing: sites really do ship chat widgets at int32 max. */
  var Z_INDEX = 2147483647;
  var MOBILE_BREAKPOINT = 640;
  var READY_TIMEOUT_MS = 15000;
  var DEFAULT_INLINE_HEIGHT = 720;

  // ---------------------------------------------------------------------------
  // Small helpers (ES5, no polyfills required)
  // ---------------------------------------------------------------------------

  var counter = 0;
  function uid() {
    counter += 1;
    return 'mbw' + Date.now().toString(36) + counter.toString(36);
  }

  function isString(v) {
    return typeof v === 'string';
  }

  function trim(v) {
    return isString(v) ? v.replace(/^\s+|\s+$/g, '') : '';
  }

  function warn(message) {
    if (window.console && window.console.warn) {
      window.console.warn('[MarinaBooking] ' + message);
    }
  }

  /** Shallow copy of `extra` onto `base`, returning a new object. */
  function merge(base, extra) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (extra) {
      for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    }
    return out;
  }

  function encode(v) {
    return encodeURIComponent(String(v));
  }

  /** Build a query string, skipping empty values so the iframe URL stays short. */
  function buildQuery(params) {
    var parts = [];
    for (var key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      var value = params[key];
      if (value === null || value === undefined || value === '' || value === false) continue;
      parts.push(encode(key) + '=' + encode(value === true ? '1' : value));
    }
    return parts.join('&');
  }

  /** Origin of an absolute URL, via an anchor so no URL constructor is needed. */
  function originOf(url) {
    var a = document.createElement('a');
    a.href = url;
    // IE-era anchors omit the port on `host` inconsistently; protocol+host is enough
    // for a postMessage target and for building our own iframe src.
    return a.protocol + '//' + a.host;
  }

  /** Accept only `#rgb` / `#rrggbb`, so a bad attribute can never inject CSS. */
  function safeHex(value) {
    var v = trim(value);
    return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : '';
  }

  function truthy(value) {
    var v = trim(value).toLowerCase();
    return v === '' ? false : v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
  }

  /**
   * `document.activeElement` stops at a shadow host, so a focused element inside
   * our own shadow root reads as the host div — which is not focusable, and
   * restoring focus to it silently drops focus to <body>. Walk down instead.
   */
  function deepActiveElement() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function on(target, type, handler, capture) {
    target.addEventListener(type, handler, capture === true);
  }

  function off(target, type, handler, capture) {
    target.removeEventListener(type, handler, capture === true);
  }

  // ---------------------------------------------------------------------------
  // Stylesheet (scoped to the shadow root; class names prefixed for the fallback)
  // ---------------------------------------------------------------------------

  function styleText(accent) {
    return [
      /* Stops host font-size, color and line-height inheriting in — but only where
         the host page has no rule of its own for that property. A `:host` rule lives
         in the inner tree, and CSS scoping gives an outer-tree NORMAL declaration the
         win, so a bare `div { … }` on the page beats this. The RESET_GUARDS and
         LAYOUT_GUARDS below are the declarations that actually hold; this rule is the
         floor beneath them, and the only protection the no-shadow-DOM fallback has. */
      ':host { all: initial; display: block; }',
      '.mbw-root, .mbw-root * { box-sizing: border-box; }',
      '.mbw-root {',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
      '  line-height: 1.4;',
      '  font-style: normal; letter-spacing: normal; text-transform: none;',
      /* Custom properties are the one thing `all: initial` does NOT reset, so a host
         page that happens to define `--mbw-accent` or `--mbw-h` inherits straight
         through the shadow boundary. Re-declaring both here takes that back: `initial`
         on a custom property makes it guaranteed-invalid, so `var(--mbw-h, 560px)`
         uses our fallback until a real resize message arrives. */
      '  --mbw-accent: ' + (accent || '#0ea5e9') + ';',
      '  --mbw-h: initial;',
      '}',

      /* Launcher button ---------------------------------------------------- */
      '.mbw-launch {',
      '  display: inline-flex; align-items: center; justify-content: center; gap: 8px;',
      '  min-height: 48px; padding: 12px 22px; border: 0; border-radius: 10px;',
      '  background: var(--mbw-accent); color: #fff; cursor: pointer;',
      '  font-size: 16px; font-weight: 600; font-family: inherit; letter-spacing: 0.01em;',
      '  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.18); text-decoration: none;',
      '  transition: filter 120ms ease, transform 120ms ease;',
      '}',
      '.mbw-launch:hover { filter: brightness(1.06); }',
      '.mbw-launch:active { transform: translateY(1px); }',
      '.mbw-launch:focus-visible { outline: 3px solid var(--mbw-accent); outline-offset: 3px; }',
      '.mbw-launch svg { flex: none; }',

      '.mbw-launch--floating {',
      '  position: fixed; bottom: 20px; z-index: ' + (Z_INDEX - 1) + ';',
      '  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.28);',
      '  border-radius: 999px; padding: 14px 24px;',
      '}',
      '.mbw-launch--floating.mbw-pos-right { right: 20px; }',
      '.mbw-launch--floating.mbw-pos-left { left: 20px; }',

      /* Inline frame ------------------------------------------------------- */
      '.mbw-inline {',
      '  display: block; width: 100%; position: relative;',
      '  border-radius: 14px; overflow: hidden;',
      '}',
      '.mbw-inline iframe { display: block; width: 100%; border: 0; background: transparent; }',

      /* Modal -------------------------------------------------------------- */
      '.mbw-overlay {',
      '  position: fixed; inset: 0; top: 0; right: 0; bottom: 0; left: 0;',
      '  z-index: ' + Z_INDEX + '; display: flex; align-items: center; justify-content: center;',
      '  padding: 24px; opacity: 0; transition: opacity 160ms ease;',
      '}',
      '.mbw-overlay.mbw-open { opacity: 1; }',
      '.mbw-backdrop {',
      '  position: absolute; inset: 0; top: 0; right: 0; bottom: 0; left: 0;',
      '  background: rgba(15, 23, 42, 0.55); -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);',
      '}',
      /* The frame reports its content height into --mbw-h; max-height caps it so a
         long checkout scrolls inside the dialog instead of off the screen. */
      '.mbw-dialog {',
      '  position: relative; display: flex; flex-direction: column;',
      '  width: 100%; max-width: 560px;',
      '  height: var(--mbw-h, 560px); min-height: 220px; max-height: 92vh;',
      '  background: #fff; border-radius: 16px; overflow: hidden;',
      '  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.4);',
      '  transform: translateY(12px); transition: transform 160ms ease;',
      '}',
      '.mbw-overlay.mbw-open .mbw-dialog { transform: translateY(0); }',
      '.mbw-dialog iframe { display: block; width: 100%; flex: 1 1 auto; border: 0; background: #fff; }',
      '.mbw-close {',
      '  position: absolute; top: 10px; right: 10px; z-index: 2;',
      '  width: 40px; height: 40px; border: 0; border-radius: 999px;',
      '  background: rgba(255, 255, 255, 0.92); color: #0f172a; cursor: pointer;',
      '  font-size: 22px; line-height: 1; font-family: inherit;',
      '  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.24);',
      '  display: flex; align-items: center; justify-content: center;',
      '}',
      '.mbw-close:hover { background: #fff; }',
      '.mbw-close:focus-visible { outline: 3px solid var(--mbw-accent); outline-offset: 2px; }',
      '.mbw-sentinel { position: absolute; width: 1px; height: 1px; opacity: 0; }',

      /* Loading + failure states ------------------------------------------- */
      '.mbw-status {',
      '  position: absolute; inset: 0; top: 0; right: 0; bottom: 0; left: 0;',
      '  display: flex; flex-direction: column; align-items: center; justify-content: center;',
      '  gap: 14px; background: #fff; color: #475569; font-size: 15px; text-align: center; padding: 24px;',
      '}',
      '.mbw-status[hidden] { display: none; }',
      '.mbw-spinner {',
      '  width: 30px; height: 30px; border-radius: 999px;',
      '  border: 3px solid rgba(100, 116, 139, 0.25); border-top-color: var(--mbw-accent);',
      '  animation: mbw-spin 800ms linear infinite;',
      '}',
      '.mbw-status a { color: var(--mbw-accent); font-weight: 600; }',
      '@keyframes mbw-spin { to { transform: rotate(360deg); } }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .mbw-spinner { animation-duration: 2400ms; }',
      '  .mbw-overlay, .mbw-dialog { transition: none; }',
      '}',

      /* Phone: the modal becomes the whole screen. ------------------------- */
      '@media (max-width: ' + MOBILE_BREAKPOINT + 'px) {',
      '  .mbw-overlay { padding: 0; }',
      '  .mbw-dialog { max-width: none; max-height: none; height: 100%; border-radius: 0; }',
      '  .mbw-launch { width: 100%; }',
      '  .mbw-launch--floating { width: auto; left: 16px; right: 16px; bottom: 16px; }',
      '}',
    ].join('\n');
  }

  var fallbackStylesInjected = false;

  /**
   * Declarations forced onto our shadow HOST element.
   *
   * The shadow root protects everything inside it, but the host element itself lives
   * in the operator's light DOM, so their `div { … }` and `body > div { … }` rules
   * match it. Worse, CSS scoping says a NORMAL declaration in the outer tree beats a
   * normal declaration in the inner tree — so `:host { all: initial }` loses to a
   * plain `div { … }` rule on the page. A style attribute marked `!important` is the
   * only declaration on that element the host page cannot outrank.
   *
   * `all: initial` does the real work; in particular it clears any `transform` /
   * `filter` / `contain`, which are what turn a top-level div into the containing
   * block for our `position: fixed` overlay (the "GPU acceleration" hack, `body > div
   * { transform: translateZ(0) }`, is on a startling number of themes). The rest are
   * restated because `all` is a shorthand an old engine may reject outright, and a
   * silent failure here reads as a layout bug rather than a missing feature.
   */
  /* Structural properties that break OUR layout if the page imposes them on an
     element of ours: a containing block for `position: fixed`, a clip, a collapsed
     or invisible box. Every element the loader creates gets these. */
  var LAYOUT_GUARDS = [
    ['position', 'static'],
    ['transform', 'none'],
    ['filter', 'none'],
    ['perspective', 'none'],
    ['contain', 'none'],
    ['clip-path', 'none'],
    ['overflow', 'visible'],
    ['float', 'none'],
    ['width', 'auto'],
    ['height', 'auto'],
    ['min-width', '0'],
    ['min-height', '0'],
    ['max-width', 'none'],
    ['max-height', 'none'],
    ['opacity', '1'],
    ['visibility', 'visible'],
    ['pointer-events', 'auto'],
    ['isolation', 'auto'],
    ['z-index', 'auto'],
  ];

  /* The full reset, for a shadow HOST only. `all: initial` has to come first — it
     is the shorthand the rest of the guards then refine — and it is what stops the
     operator's typography inheriting across the shadow boundary.

     The mount anchor deliberately does NOT get these: it sits in the operator's own
     text flow, and resetting it would throw away their `text-align: center` and
     left-align a button they had centred. */
  var RESET_GUARDS = [
    ['all', 'initial'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', '0'],
    ['font-style', 'normal'],
    ['letter-spacing', 'normal'],
    ['text-transform', 'none'],
  ];

  /**
   * Pin an element of ours against the host page's stylesheet.
   *
   * @param full true for a shadow host (structure + typography reset), false for a
   *             wrapper that should still inherit the operator's page context
   */
  function harden(el, display, full) {
    var lists = full ? [RESET_GUARDS, LAYOUT_GUARDS] : [LAYOUT_GUARDS];
    for (var l = 0; l < lists.length; l += 1) {
      for (var i = 0; i < lists[l].length; i += 1) {
        try {
          el.style.setProperty(lists[l][i][0], lists[l][i][1], 'important');
        } catch (err) {
          /* An engine that rejects one property must still get the rest. */
        }
      }
    }
    if (display) el.style.setProperty('display', display, 'important');
  }

  /**
   * Create an isolated render surface. Shadow DOM where available (real style
   * isolation in both directions); otherwise a prefixed-class container with the
   * same stylesheet appended to <head> once.
   */
  function createSurface(accent, display) {
    var host = document.createElement('div');
    host.className = 'mbw-host';
    host.setAttribute('data-marina-embed', '');
    harden(host, display, true);

    var root;
    if (typeof host.attachShadow === 'function') {
      root = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = styleText(accent);
      root.appendChild(style);
    } else {
      root = host;
      if (!fallbackStylesInjected) {
        fallbackStylesInjected = true;
        var head = document.head || document.getElementsByTagName('head')[0];
        var el = document.createElement('style');
        el.appendChild(document.createTextNode(styleText(accent)));
        if (head) head.appendChild(el);
      }
    }

    var container = document.createElement('div');
    container.className = 'mbw-root';
    if (accent) container.style.setProperty('--mbw-accent', accent);
    root.appendChild(container);

    return { host: host, root: root, container: container };
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /** Locate the <script> element that is executing right now. */
  function currentScript() {
    if (document.currentScript) return document.currentScript;
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      var src = scripts[i].getAttribute('src') || '';
      if (src.indexOf('embed.js') !== -1) return scripts[i];
    }
    return null;
  }

  function attr(el, name) {
    if (!el) return '';
    var v = el.getAttribute(name);
    return v === null ? '' : trim(v);
  }

  /**
   * Read a widget's configuration off its script tag. The base URL defaults to
   * wherever embed.js itself was served from, so an operator only ever pastes one
   * host name and multi-tenant deploys resolve the operator from that host.
   */
  function configFromScript(script) {
    var src = script ? script.src || attr(script, 'src') : '';
    var base = attr(script, 'data-base') || (src ? originOf(src) : '');
    var mode = attr(script, 'data-mode').toLowerCase();
    var target = attr(script, 'data-target');

    if (!mode) mode = target ? 'inline' : 'button';
    if (mode !== 'inline' && mode !== 'button' && mode !== 'floating' && mode !== 'manual') {
      warn('Unknown data-mode "' + mode + '"; falling back to "button".');
      mode = 'button';
    }

    var height = parseInt(attr(script, 'data-height'), 10);

    return {
      base: base || originOf(window.location.href),
      operator: attr(script, 'data-operator'),
      activity: attr(script, 'data-activity'),
      mode: mode,
      target: target,
      label: attr(script, 'data-label') || 'Book now',
      color: safeHex(attr(script, 'data-color')),
      position: attr(script, 'data-position').toLowerCase() === 'bottom-left' ? 'left' : 'right',
      height: isNaN(height) || height < 200 ? DEFAULT_INLINE_HEIGHT : height,
      autoOpen: truthy(attr(script, 'data-open')),
      title: attr(script, 'data-title') || 'Book online',
    };
  }

  // ---------------------------------------------------------------------------
  // Event bus (one per widget, plus a global one on the namespace)
  // ---------------------------------------------------------------------------

  function createBus() {
    var handlers = {};
    return {
      on: function (type, fn) {
        if (!isString(type) || typeof fn !== 'function') return;
        (handlers[type] || (handlers[type] = [])).push(fn);
      },
      off: function (type, fn) {
        var list = handlers[type];
        if (!list) return;
        for (var i = list.length - 1; i >= 0; i -= 1) {
          if (list[i] === fn) list.splice(i, 1);
        }
      },
      emit: function (type, detail) {
        var list = handlers[type];
        if (!list) return;
        for (var i = 0; i < list.length; i += 1) {
          // One bad operator handler must never break the booking flow.
          try {
            list[i](detail);
          } catch (err) {
            warn('A "' + type + '" handler threw: ' + err);
          }
        }
      },
    };
  }

  var globalBus = createBus();

  /**
   * Publish an event three ways so an operator can wire analytics with whatever
   * they already have: our own `on()` API, a DOM CustomEvent, and — when Google
   * Tag Manager is present — a dataLayer push.
   */
  function publish(widget, type, detail) {
    widget.bus.emit(type, detail);
    globalBus.emit(type, detail);

    if (typeof window.CustomEvent === 'function') {
      window.dispatchEvent(
        new window.CustomEvent('marina:' + type, { detail: detail })
      );
    }

    if (type === 'booking' && Object.prototype.toString.call(window.dataLayer) === '[object Array]') {
      try {
        window.dataLayer.push(
          merge(detail, { event: 'marina_booking_completed' })
        );
      } catch (err) {
        warn('dataLayer push failed: ' + err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The widget
  // ---------------------------------------------------------------------------

  var widgetsById = {};

  function Widget(config) {
    this.id = uid();
    this.config = config;
    this.frameOrigin = originOf(config.base);
    this.bus = createBus();

    this.iframe = null;
    this.surface = null;
    this.overlay = null;
    this.launcher = null;
    this.statusEl = null;
    this.ready = false;
    this.isOpen = false;
    this.lastFocused = null;
    this.readyTimer = null;
    /** Inline `overflow` the host had on <html> and <body> before we locked them. */
    this.previousOverflow = null;
    /** The phone-breakpoint listener a button launcher installs, for teardown. */
    this.launcherQuery = null;
    this.destroyed = false;

    widgetsById[this.id] = this;
  }

  /** The iframe URL for this widget, optionally overridden per open() call. */
  Widget.prototype.frameUrl = function (overrides) {
    var c = merge(this.config, overrides);
    var query = buildQuery({
      eid: this.id,
      operator: c.operator,
      activity: c.activity,
      // `locked` tells /embed this widget is pinned to one activity, so it hides
      // the "all activities" navigation instead of offering a dead end.
      locked: c.activity ? '1' : '',
      mode: c.mode === 'inline' ? 'inline' : 'modal',
      accent: c.color,
      v: PROTOCOL_VERSION,
    });
    return c.base + '/embed?' + query;
  };

  /** A plain link to the same flow — the fallback when the iframe cannot load. */
  Widget.prototype.directUrl = function () {
    var c = this.config;
    return c.activity
      ? c.base + '/activities/' + encode(c.activity)
      : c.base + '/';
  };

  /**
   * @param overrides  per-open config overrides for the frame URL
   * @param growsToFit true when the frame's height tracks its content (inline mode),
   *                   which is the only case where suppressing its scrollbar is safe
   */
  Widget.prototype.buildIframe = function (overrides, growsToFit) {
    var iframe = document.createElement('iframe');
    iframe.src = this.frameUrl(overrides);
    iframe.title = this.config.title;
    /* Inline grows to whatever height the frame reports, so it never needs a
       scrollbar and `scrolling="no"` stops a transient one flashing mid-measure.
       A MODAL is capped at 92vh, so anything taller than that has to scroll inside
       the frame — `scrolling="no"` there does not tidy a scrollbar away, it makes
       the bottom of the checkout permanently unreachable. */
    if (growsToFit) iframe.setAttribute('scrolling', 'no');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    // Wallet payments and Stripe's 3DS challenge both need these grants.
    iframe.setAttribute('allow', "payment 'src'; clipboard-write");
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups ' +
        'allow-popups-to-escape-sandbox allow-modals allow-storage-access-by-user-activation'
    );
    iframe.style.width = '100%';
    iframe.style.border = '0';
    return iframe;
  };

  Widget.prototype.buildStatus = function () {
    var status = document.createElement('div');
    status.className = 'mbw-status';
    var spinner = document.createElement('div');
    spinner.className = 'mbw-spinner';
    var label = document.createElement('div');
    label.appendChild(document.createTextNode('Loading availability…'));
    status.appendChild(spinner);
    status.appendChild(label);
    this.statusEl = status;
    this.statusLabel = label;
    this.statusSpinner = spinner;
    return status;
  };

  /** Swap the loading state for a plain link when the iframe never reports ready. */
  Widget.prototype.failToLink = function () {
    if (this.ready || !this.statusEl) return;
    var url = this.directUrl();
    if (this.statusSpinner && this.statusSpinner.parentNode) {
      this.statusSpinner.parentNode.removeChild(this.statusSpinner);
    }
    while (this.statusLabel.firstChild) {
      this.statusLabel.removeChild(this.statusLabel.firstChild);
    }
    this.statusLabel.appendChild(
      document.createTextNode('The booking window did not load. ')
    );
    var link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.appendChild(document.createTextNode('Open booking in a new tab'));
    this.statusLabel.appendChild(link);
    publish(this, 'error', { id: this.id, reason: 'frame-timeout', url: url });
  };

  Widget.prototype.armReadyTimeout = function () {
    var self = this;
    this.clearReadyTimeout();
    this.readyTimer = window.setTimeout(function () {
      self.failToLink();
    }, READY_TIMEOUT_MS);
  };

  Widget.prototype.clearReadyTimeout = function () {
    if (this.readyTimer) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  };

  // --- inline ---------------------------------------------------------------

  Widget.prototype.mountInline = function (mountPoint) {
    if (this.surface) return this;

    var surface = createSurface(this.config.color, 'block');
    this.surface = surface;

    var wrap = document.createElement('div');
    wrap.className = 'mbw-inline';
    wrap.style.minHeight = this.config.height + 'px';

    var iframe = this.buildIframe(null, true);
    iframe.style.height = this.config.height + 'px';
    this.iframe = iframe;

    wrap.appendChild(iframe);
    wrap.appendChild(this.buildStatus());
    surface.container.appendChild(wrap);

    mountPoint.appendChild(surface.host);
    this.armReadyTimeout();
    return this;
  };

  // --- launcher -------------------------------------------------------------

  /**
   * Keep the launcher's host box in step with the stylesheet's phone breakpoint.
   *
   * A button-mode launcher sits in the operator's text flow, so its host element is
   * inline-block — and that silently makes the stylesheet's `.mbw-launch { width:
   * 100% }` phone rule a no-op, because 100% of a shrink-to-fit box is the button's
   * own width. The host has to become a block box at the same breakpoint, and the
   * only place we can say so is the style attribute (see harden), which cannot
   * carry a media query. So: watch the query, restate the display.
   */
  Widget.prototype.trackLauncherBox = function (host) {
    if (!window.matchMedia) {
      host.style.setProperty('display', 'inline-block', 'important');
      return;
    }
    var query = window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT + 'px)');
    var apply = function () {
      host.style.setProperty('display', query.matches ? 'block' : 'inline-block', 'important');
    };
    apply();
    if (query.addEventListener) query.addEventListener('change', apply);
    else if (query.addListener) query.addListener(apply); // Safari < 14
    this.launcherQuery = { query: query, apply: apply };
  };

  Widget.prototype.mountLauncher = function (mountPoint, floating) {
    if (this.launcher) return this;

    var surface = createSurface(this.config.color, 'block');
    this.surface = surface;
    if (!floating) this.trackLauncherBox(surface.host);

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'mbw-launch' + (floating ? ' mbw-launch--floating mbw-pos-' + this.config.position : '');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');

    // Inline SVG so the button needs no font, image, or network request.
    var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '18');
    icon.setAttribute('height', '18');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    var paths = [
      'M8 2v4', 'M16 2v4', 'M3 10h18',
    ];
    for (var i = 0; i < paths.length; i += 1) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', paths[i]);
      icon.appendChild(p);
    }
    var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '3');
    rect.setAttribute('y', '4');
    rect.setAttribute('width', '18');
    rect.setAttribute('height', '18');
    rect.setAttribute('rx', '2');
    icon.appendChild(rect);

    button.appendChild(icon);
    button.appendChild(document.createTextNode(this.config.label));

    var self = this;
    on(button, 'click', function () {
      self.open();
    });

    this.launcher = button;
    surface.container.appendChild(button);
    mountPoint.appendChild(surface.host);
    return this;
  };

  // --- modal ----------------------------------------------------------------

  Widget.prototype.open = function (overrides) {
    if (this.destroyed || this.isOpen) return this;
    this.isOpen = true;
    this.ready = false;
    this.lastFocused = deepActiveElement();

    /* The overlay gets its OWN surface attached to <body>, never the launcher's.
       A host ancestor with `transform` or `filter` would otherwise become the
       containing block for our position:fixed overlay and clip it to that box.

       Re-appended on EVERY open, not just the first. Our z-index is already int32
       max, so the only thing that can cover us is something that ties — and a tie is
       resolved by document order. Chat widgets, consent gates and "back to top"
       buttons are all injected by tag managers after the page has settled, i.e.
       after we mounted. Moving our host back to the end of <body> costs nothing (the
       shadow root travels with it) and settles the tie in our favour. */
    if (!this.modalSurface) this.modalSurface = createSurface(this.config.color, 'block');
    document.body.appendChild(this.modalSurface.host);

    var self = this;
    var overlay = document.createElement('div');
    overlay.className = 'mbw-overlay';

    var backdrop = document.createElement('div');
    backdrop.className = 'mbw-backdrop';
    on(backdrop, 'click', function () {
      self.close('backdrop');
    });

    var dialog = document.createElement('div');
    dialog.className = 'mbw-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', this.config.title);

    var startSentinel = document.createElement('span');
    startSentinel.className = 'mbw-sentinel';
    startSentinel.tabIndex = 0;

    var endSentinel = document.createElement('span');
    endSentinel.className = 'mbw-sentinel';
    endSentinel.tabIndex = 0;

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'mbw-close';
    close.setAttribute('aria-label', 'Close booking');
    close.appendChild(document.createTextNode('×'));
    on(close, 'click', function () {
      self.close('button');
    });

    var iframe = this.buildIframe(overrides, false);
    iframe.style.height = '100%';
    this.iframe = iframe;

    /* Focus trap. The sentinels have to be the FIRST and LAST tab stops in the
       dialog, which means the start sentinel goes before the close button — with it
       after, Shift+Tab off the close button walked straight out of the dialog and
       onto the host page, which is the whole failure mode a trap exists to prevent.
       Tabbing forwards off the end wraps to the close button; backwards off the
       start wraps to the frame. Focus moves through the frame's own document
       naturally in between; a cross-origin frame is a single stop from out here, so
       backwards-wrapping lands at its top rather than its last field. */
    on(startSentinel, 'focus', function () {
      iframe.focus();
    });
    on(endSentinel, 'focus', function () {
      close.focus();
    });

    dialog.appendChild(startSentinel);
    dialog.appendChild(close);
    dialog.appendChild(iframe);
    dialog.appendChild(this.buildStatus());
    dialog.appendChild(endSentinel);

    overlay.appendChild(backdrop);
    overlay.appendChild(dialog);
    this.modalSurface.container.appendChild(overlay);
    this.overlay = overlay;
    this.closeButton = close;

    /* Lock host scrolling while the overlay owns the screen, remembering whatever the
       host had set so we restore it exactly.

       BOTH elements, not just <body>. The body's overflow only propagates to the
       viewport while <html>'s own overflow is `visible`, and `html { overflow-x:
       hidden }` — the standard fix for an accidental horizontal scrollbar, and on a
       large share of real themes — takes that away. On those pages locking the body
       alone does literally nothing and the page scrolls behind the modal. */
    this.previousOverflow = {
      body: document.body.style.overflow,
      root: document.documentElement.style.overflow,
    };
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    this.onKeydown = function (event) {
      if (event.key === 'Escape' || event.keyCode === 27) {
        event.stopPropagation();
        self.close('escape');
      }
    };
    on(document, 'keydown', this.onKeydown, true);

    if (this.launcher) this.launcher.setAttribute('aria-expanded', 'true');

    // Next frame, so the opening transition actually runs.
    window.setTimeout(function () {
      overlay.className = 'mbw-overlay mbw-open';
      close.focus();
    }, 16);

    this.armReadyTimeout();
    publish(this, 'open', { id: this.id });
    return this;
  };

  Widget.prototype.close = function (reason) {
    if (!this.isOpen) return this;
    this.isOpen = false;
    this.ready = false;
    this.clearReadyTimeout();

    if (this.onKeydown) {
      off(document, 'keydown', this.onKeydown, true);
      this.onKeydown = null;
    }

    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.overlay = null;
    this.iframe = null;
    this.statusEl = null;

    if (this.previousOverflow) {
      document.body.style.overflow = this.previousOverflow.body;
      document.documentElement.style.overflow = this.previousOverflow.root;
      this.previousOverflow = null;
    }

    if (this.launcher) this.launcher.setAttribute('aria-expanded', 'false');

    // Return focus where the customer left it, per WAI-ARIA dialog practice. The
    // launcher wins when there is one: it is the control that owns the dialog,
    // and it is guaranteed to still be in the document.
    var restore = this.launcher || this.lastFocused;
    if (restore && typeof restore.focus === 'function') {
      try {
        restore.focus();
      } catch (err) {
        /* The host may have removed the element while the modal was open. */
      }
    }
    this.lastFocused = null;

    publish(this, 'close', { id: this.id, reason: reason || 'api' });
    return this;
  };

  Widget.prototype.destroy = function () {
    this.close('destroy');
    this.clearReadyTimeout();

    // A media-query listener left behind would keep a reference to a detached host.
    if (this.launcherQuery) {
      var q = this.launcherQuery;
      if (q.query.removeEventListener) q.query.removeEventListener('change', q.apply);
      else if (q.query.removeListener) q.query.removeListener(q.apply);
      this.launcherQuery = null;
    }

    var surfaces = [this.surface, this.modalSurface];
    for (var i = 0; i < surfaces.length; i += 1) {
      var s = surfaces[i];
      if (s && s.host && s.host.parentNode) s.host.parentNode.removeChild(s.host);
    }
    this.surface = null;
    this.modalSurface = null;
    this.launcher = null;
    this.destroyed = true;
    delete widgetsById[this.id];
  };

  // --- messages from the iframe --------------------------------------------

  Widget.prototype.send = function (type, payload) {
    if (!this.iframe || !this.iframe.contentWindow) return;
    this.iframe.contentWindow.postMessage(
      {
        source: PROTOCOL,
        v: PROTOCOL_VERSION,
        id: this.id,
        type: type,
        payload: payload || {},
      },
      this.frameOrigin
    );
  };

  Widget.prototype.applyHeight = function (height) {
    if (!this.iframe || !height || height < 80) return;
    var px = Math.ceil(height);

    if (this.overlay) {
      // The dialog shrink-wraps the content up to its max-height; past that the
      // iframe scrolls internally, which is what a modal should do.
      var dialog = this.iframe.parentNode;
      if (dialog && dialog.style) dialog.style.setProperty('--mbw-h', px + 'px');
      return;
    }

    // Inline: the iframe is exactly as tall as its content, so the host page
    // scrolls and the widget never has a scrollbar of its own.
    this.iframe.style.height = px + 'px';
    if (this.iframe.parentNode && this.iframe.parentNode.className === 'mbw-inline') {
      this.iframe.parentNode.style.minHeight = '0px';
    }
  };

  Widget.prototype.handleMessage = function (message, event) {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.clearReadyTimeout();
        if (this.statusEl) this.statusEl.hidden = true;
        // Tell the frame who is hosting it, so its own replies can be addressed
        // to this exact origin instead of "*".
        this.send('host', {
          origin: window.location.origin || originOf(window.location.href),
          href: window.location.href,
          mode: this.overlay ? 'modal' : 'inline',
          title: document.title,
        });
        publish(this, 'ready', { id: this.id, step: message.payload.step });
        break;

      case 'resize':
        this.applyHeight(message.payload.height);
        publish(this, 'resize', { id: this.id, height: message.payload.height });
        break;

      case 'step':
        publish(this, 'step', merge(message.payload, { id: this.id }));
        break;

      case 'close':
        this.close(message.payload.reason || 'frame');
        break;

      case 'booking-completed':
        publish(this, 'booking', merge(message.payload, { id: this.id }));
        break;

      case 'navigate':
        // The frame asks the host to open a link that does not belong inside the
        // widget (terms, "look up my booking"). A user gesture inside the iframe
        // preceded it, so a popup blocker generally allows this.
        if (isString(message.payload.url)) {
          var url = message.payload.url;
          if (url.indexOf(this.frameOrigin) === 0) {
            window.open(url, '_blank', 'noopener');
          }
        }
        publish(this, 'navigate', merge(message.payload, { id: this.id }));
        break;

      default:
        break;
    }
    // `event` is intentionally unused beyond validation done by the router below.
    void event;
  };

  /** Single delegated listener: cheaper than one per widget, and easier to audit. */
  function routeMessage(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== PROTOCOL || data.v !== PROTOCOL_VERSION) return;

    var widget = widgetsById[data.id];
    if (!widget || !widget.iframe) return;

    // Two independent checks: the message must come from the exact window we
    // created, and from the origin we pointed it at.
    if (event.source !== widget.iframe.contentWindow) return;
    if (event.origin !== widget.frameOrigin) return;

    widget.handleMessage({ type: String(data.type), payload: data.payload || {} }, event);
  }

  on(window, 'message', routeMessage, false);

  // ---------------------------------------------------------------------------
  // Mounting
  // ---------------------------------------------------------------------------

  /** Where a widget's DOM goes: an explicit target, or right after its script. */
  function resolveMountPoint(config, script) {
    if (config.target) {
      var el = null;
      try {
        el = document.querySelector(config.target);
      } catch (err) {
        warn('data-target is not a valid CSS selector: ' + config.target);
      }
      if (el) return el;
      warn('data-target "' + config.target + '" matched nothing; mounting inline instead.');
    }

    // Ours, not theirs — so it gets the same guards as a surface host. Without them
    // a `body > div { transform: … }` rule on the page turns this wrapper into the
    // containing block for anything fixed inside it.
    var anchor = document.createElement('div');
    harden(anchor, 'block', false);
    if (script && script.parentNode) {
      script.parentNode.insertBefore(anchor, script.nextSibling);
    } else {
      document.body.appendChild(anchor);
    }
    return anchor;
  }

  function mountWidget(config, script) {
    var widget = new Widget(config);

    if (config.mode === 'manual') {
      // Nothing rendered — the operator opens it from their own button.
    } else if (config.mode === 'inline') {
      widget.mountInline(resolveMountPoint(config, script));
    } else if (config.mode === 'floating') {
      widget.mountLauncher(document.body, true);
    } else {
      widget.mountLauncher(resolveMountPoint(config, script), false);
    }

    if (config.autoOpen && config.mode !== 'inline') widget.open();
    return widget;
  }

  function whenReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      window.setTimeout(fn, 0);
    } else {
      on(document, 'DOMContentLoaded', function handler() {
        off(document, 'DOMContentLoaded', handler, false);
        fn();
      }, false);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — the one and only global
  // ---------------------------------------------------------------------------

  var existing = window[NAMESPACE];
  if (existing && existing.__marinaEmbed) {
    // A second copy of the script on the same page: reuse the first API object so
    // the operator's `on()` handlers keep working, and just mount the new tag.
    var scriptEl = currentScript();
    whenReady(function () {
      existing.widgets.push(mountWidget(configFromScript(scriptEl), scriptEl));
    });
    return;
  }

  var script = currentScript();
  var defaults = configFromScript(script);

  var api = {
    __marinaEmbed: true,
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    widgets: [],

    /** Configuration read off the first script tag; useful for debugging. */
    defaults: defaults,

    /**
     * Open the booking modal. Options override the script-tag attributes for this
     * one open, e.g. MarinaBooking.open({ activity: 'kayak-double' }).
     */
    open: function (options) {
      // Prefer a widget that already owns a launcher (so focus returns to it on
      // close); an inline widget is never hijacked into a modal.
      var widget = null;
      for (var i = 0; i < api.widgets.length; i += 1) {
        var w = api.widgets[i];
        if (!w.destroyed && w.config.mode !== 'inline') {
          widget = w;
          break;
        }
      }
      if (!widget) {
        widget = mountWidget(merge(defaults, merge(options || {}, { mode: 'manual' })), null);
        api.widgets.push(widget);
      }
      // `open` overrides only affect the frame URL, so pass them straight through.
      return widget.open(options);
    },

    /** Close every open widget on the page. */
    close: function () {
      for (var i = 0; i < api.widgets.length; i += 1) api.widgets[i].close('api');
      return api;
    },

    /**
     * Render the flow inline into an element (or CSS selector). Returns the
     * widget so it can later be destroyed.
     */
    mount: function (target, options) {
      var el = isString(target) ? document.querySelector(target) : target;
      if (!el) {
        warn('mount() could not find ' + target);
        return null;
      }
      var widget = new Widget(merge(defaults, merge(options || {}, { mode: 'inline' })));
      widget.mountInline(el);
      api.widgets.push(widget);
      return widget;
    },

    /** Subscribe to widget events: open, close, ready, step, resize, booking, navigate, error. */
    on: function (type, fn) {
      globalBus.on(type, fn);
      return api;
    },

    off: function (type, fn) {
      globalBus.off(type, fn);
      return api;
    },

    /** Tear down every widget this script created. */
    destroy: function () {
      for (var i = api.widgets.length - 1; i >= 0; i -= 1) api.widgets[i].destroy();
      api.widgets.length = 0;
      return api;
    },
  };

  window[NAMESPACE] = api;

  whenReady(function () {
    api.widgets.push(mountWidget(defaults, script));
  });
})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);
