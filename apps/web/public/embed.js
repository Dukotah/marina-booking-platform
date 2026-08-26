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
  var VERSION = '1.0.0';
  var PROTOCOL = 'marina-embed';
  var PROTOCOL_VERSION = 1;

  /* The overlay must clear sticky headers and cookie banners without using
     Number.MAX_SAFE_INTEGER, which some host stacking contexts fight over. */
  var Z_INDEX = 2147483000;
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
      /* `all: initial` is the point of the shadow root: no host font-size, color,
         line-height, or reset leaks in. It also resets display, so restore it. */
      ':host { all: initial; display: block; }',
      '.mbw-root, .mbw-root * { box-sizing: border-box; }',
      '.mbw-root {',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
      '  line-height: 1.4;',
      '  --mbw-accent: ' + (accent || '#0ea5e9') + ';',
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
      '  position: fixed; bottom: 20px; z-index: ' + (Z_INDEX - 10) + ';',
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
   * Create an isolated render surface. Shadow DOM where available (real style
   * isolation in both directions); otherwise a prefixed-class container with the
   * same stylesheet appended to <head> once.
   */
  function createSurface(accent) {
    var host = document.createElement('div');
    host.className = 'mbw-host';
    host.setAttribute('data-marina-embed', '');

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
    this.previousBodyOverflow = null;
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

  Widget.prototype.buildIframe = function (overrides) {
    var iframe = document.createElement('iframe');
    iframe.src = this.frameUrl(overrides);
    iframe.title = this.config.title;
    iframe.setAttribute('scrolling', 'no');
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

    var surface = createSurface(this.config.color);
    this.surface = surface;

    var wrap = document.createElement('div');
    wrap.className = 'mbw-inline';
    wrap.style.minHeight = this.config.height + 'px';

    var iframe = this.buildIframe();
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

  Widget.prototype.mountLauncher = function (mountPoint, floating) {
    if (this.launcher) return this;

    var surface = createSurface(this.config.color);
    this.surface = surface;
    // An inline-block host keeps a launcher sitting in the operator's text flow
    // instead of claiming a whole row. Inline styles beat the `:host` rule.
    if (!floating) surface.host.style.display = 'inline-block';

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
       containing block for our position:fixed overlay and clip it to that box. */
    if (!this.modalSurface) {
      this.modalSurface = createSurface(this.config.color);
      document.body.appendChild(this.modalSurface.host);
    }

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

    var iframe = this.buildIframe(overrides);
    iframe.style.height = '100%';
    this.iframe = iframe;

    /* Focus trap: the sentinels are the first and last tab stops inside the
       dialog, so tabbing off either end wraps back into it. Focus moves into the
       iframe's own document naturally in between — the browser handles that. */
    on(startSentinel, 'focus', function () {
      iframe.focus();
    });
    on(endSentinel, 'focus', function () {
      close.focus();
    });

    dialog.appendChild(close);
    dialog.appendChild(startSentinel);
    dialog.appendChild(iframe);
    dialog.appendChild(this.buildStatus());
    dialog.appendChild(endSentinel);

    overlay.appendChild(backdrop);
    overlay.appendChild(dialog);
    this.modalSurface.container.appendChild(overlay);
    this.overlay = overlay;
    this.closeButton = close;

    // Lock host scrolling while the overlay owns the screen, remembering whatever
    // the host had set so we restore it exactly.
    this.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

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

    document.body.style.overflow = this.previousBodyOverflow || '';
    this.previousBodyOverflow = null;

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

    var anchor = document.createElement('div');
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
