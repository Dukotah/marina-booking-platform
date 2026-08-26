'use client';

/**
 * Per-step session work for the embedded flow: pin the tenant, and tell the host
 * page which step the customer is on.
 *
 * Tenant: `lib/api` resolves the operator from an `operator_slug` cookie in the
 * browser, falling back to the deployment default. The canonical resolution for a
 * real install is the host name the widget is served from (`book.theirmarina.com`),
 * which the API's tenant middleware already handles server-side — this cookie only
 * covers browser-side catalog/availability calls, and it is written during render
 * rather than in an effect so it lands before the availability calendar's first
 * fetch. Third-party cookie blocking can drop it; that is why it is a hint, not
 * the mechanism.
 *
 * Step: pure analytics for the operator. Each step change becomes a `step` message
 * the host can forward to their own funnel tracking.
 */

import { useEffect, useRef, useState } from 'react';
import { postToHost } from './protocol';

interface EmbedSessionProps {
  operator: string;
  step: string;
  activityId: string;
}

function applyOperatorCookie(slug: string): void {
  if (typeof document === 'undefined' || !slug) return;
  if (document.cookie.indexOf(`operator_slug=${encodeURIComponent(slug)}`) !== -1) return;
  // Session cookie, SameSite=None so it survives being read inside a third-party
  // frame (which is exactly what an embed is). Secure is required alongside None;
  // on plain-http local dev the browser drops it and we fall back to the default.
  document.cookie = `operator_slug=${encodeURIComponent(slug)}; path=/; SameSite=None; Secure`;
}

export function EmbedSession({ operator, step, activityId }: EmbedSessionProps) {
  // useState's initializer runs during render — before any child effect — which is
  // the ordering the cookie needs. It is idempotent, so a StrictMode double call
  // costs nothing.
  useState(() => {
    applyOperatorCookie(operator);
    return null;
  });

  const reported = useRef<string | null>(null);

  useEffect(() => {
    const key = `${step}:${activityId}`;
    if (reported.current === key) return;
    reported.current = key;
    postToHost('step', { step, activityId: activityId || null });
  }, [step, activityId]);

  return null;
}

export default EmbedSession;
