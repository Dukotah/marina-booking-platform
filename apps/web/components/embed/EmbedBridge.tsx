'use client';

/**
 * The iframe half of the host bridge. Mounted once by the embed layout, so it
 * survives every step change (the whole flow stays on the `/embed` route — see
 * params.ts for why).
 *
 * It owns three things the operator's page cannot do for itself:
 *
 *   1. Height. A cross-origin host cannot measure our content, so we measure it
 *      and report it. A ResizeObserver on the document element catches layout
 *      changes; a MutationObserver covers late content (images, fonts) in
 *      browsers where the observed box does not change.
 *   2. Escape. A key pressed inside an iframe never reaches the host document, so
 *      the modal could not otherwise be closed from the keyboard.
 *   3. The handshake, which tells us the host's exact origin so booking detail is
 *      not posted to `*`.
 */

import { useEffect } from 'react';
import {
  isFramed,
  postToHost,
  readHostEnvelope,
  setHostOrigin,
  setInstanceId,
} from './protocol';

/** Height of the rendered document, rounded up so a fractional pixel never clips. */
function measure(): number {
  const doc = document.documentElement;
  const body = document.body;
  return Math.ceil(
    Math.max(
      doc?.scrollHeight ?? 0,
      doc?.offsetHeight ?? 0,
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
    ),
  );
}

export function EmbedBridge() {
  useEffect(() => {
    // Read the instance id straight off the URL rather than taking it as a prop:
    // this component is mounted by the layout, which cannot see search params,
    // and mounting it there is what keeps the bridge alive across every step.
    const search = new URLSearchParams(window.location.search);
    setInstanceId((search.get('eid') ?? '').slice(0, 64));

    // Fallback for engines without CSS `:has()` — embed.css needs a hook on
    // <body> to cancel the root layout's `min-h-screen`, which would otherwise
    // pin the document to the iframe's height and stop it ever shrinking.
    document.body.classList.add('marina-embed-body');

    if (!isFramed()) return;

    let lastHeight = 0;
    let frame = 0;

    const report = () => {
      frame = 0;
      const height = measure();
      // A one-pixel jitter loop between host and frame is a classic embed bug;
      // only speak up when the change is real.
      if (Math.abs(height - lastHeight) < 2) return;
      lastHeight = height;
      postToHost('resize', { height });
    };

    const scheduleReport = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(report);
    };

    const onMessage = (event: MessageEvent) => {
      const envelope = readHostEnvelope(event.data);
      if (!envelope || envelope.type !== 'host') return;
      const origin = envelope.payload.origin;
      if (typeof origin === 'string' && origin) setHostOrigin(origin);
      // The host may have resized us on open; re-measure against the new viewport.
      lastHeight = 0;
      scheduleReport();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      postToHost('close', { reason: 'escape' });
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('load', scheduleReport);

    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleReport) : null;
    resizeObserver?.observe(document.documentElement);
    if (document.body) resizeObserver?.observe(document.body);

    const mutationObserver =
      typeof MutationObserver === 'function' ? new MutationObserver(scheduleReport) : null;
    mutationObserver?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    // Belt and braces for browsers without either observer, and for web fonts
    // settling a beat after first paint.
    const interval = window.setInterval(scheduleReport, 1000);

    postToHost('ready', { step: search.get('step') ?? 'catalog' });
    scheduleReport();

    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('load', scheduleReport);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.clearInterval(interval);
      if (frame) window.cancelAnimationFrame(frame);
    };
    // Install once for the life of the widget. Later step changes are reported by
    // EmbedSession; re-running this would re-handshake for no reason.
  }, []);

  return null;
}

export default EmbedBridge;
