'use client';

/**
 * Keeps the booking flow inside the iframe without forking it.
 *
 * The components we reuse here — BookingWidget, CheckoutClient, ActivityCard,
 * every `<Link>` inside them — navigate to the standalone customer-portal routes
 * (`/activities/:id`, `/checkout?…`, `/confirmation?order=…`). Those routes render
 * the site header and footer, which must never appear inside somebody else's
 * page. Rather than copy those components and change their hrefs (which would
 * fork the booking logic and let the two copies drift), we override the App
 * Router instance they resolve through and translate each destination into the
 * equivalent `/embed?step=…` URL.
 *
 * `next/link` and `useRouter()` both read the router from `AppRouterContext`, so
 * providing our own value covers every navigation the reused components can make.
 * It is a Next internal import, but a stable one — it is the same seam Storybook
 * and next-router-mock use, and it is the only interception point that catches
 * `<Link>` clicks as well as imperative pushes.
 *
 * Anything that is genuinely not part of the booking flow (terms, privacy,
 * "look up my booking") is not navigated at all: we ask the host page to open it
 * in a new tab, so the customer never loses a half-finished booking.
 */

import { useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { buildEmbedHref, type EmbedSessionParams } from './params';
import { postToHost } from './protocol';

interface EmbedRouterProviderProps {
  session: EmbedSessionParams;
  children: ReactNode;
}

type Destination =
  | { kind: 'embed'; href: string }
  /** Not part of the booking flow — hand it to the host page instead. */
  | { kind: 'host'; url: string };

const ACTIVITY_PATH = /^\/activities\/([^/]+)\/?$/;

/** Map a customer-portal href onto its embedded equivalent. */
export function translateHref(href: string, session: EmbedSessionParams): Destination {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return { kind: 'embed', href: buildEmbedHref(session, 'catalog') };
  }

  if (url.origin !== window.location.origin) return { kind: 'host', url: url.href };

  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;

  if (path === '/embed') return { kind: 'embed', href: `${url.pathname}${url.search}` };

  if (path === '/' || path === '/activities') {
    // A pinned widget has no catalog to fall back to; keep it on its activity.
    return session.locked
      ? { kind: 'embed', href: buildEmbedHref(session, 'activity', { activityId: session.activity }) }
      : { kind: 'embed', href: buildEmbedHref(session, 'catalog') };
  }

  const activity = ACTIVITY_PATH.exec(path);
  if (activity) {
    return {
      kind: 'embed',
      href: buildEmbedHref(session, 'activity', {
        activityId: decodeURIComponent(activity[1] as string),
      }),
    };
  }

  if (path === '/checkout') {
    return {
      kind: 'embed',
      href: buildEmbedHref(session, 'checkout', {
        activityId: q.get('activityId') ?? undefined,
        rateId: q.get('rateId') ?? undefined,
        timeslotId: q.get('timeslotId') ?? undefined,
        date: q.get('date') ?? undefined,
        quantity: q.get('quantity') ?? undefined,
      }),
    };
  }

  if (path === '/confirmation') {
    return {
      kind: 'embed',
      href: buildEmbedHref(session, 'confirmation', {
        order: q.get('order') ?? q.get('orderNumber') ?? undefined,
      }),
    };
  }

  return { kind: 'host', url: url.href };
}

export function EmbedRouterProvider({ session, children }: EmbedRouterProviderProps) {
  const router = useRouter();

  const embeddedRouter = useMemo<AppRouterInstance>(() => {
    const go = (
      href: string,
      navigate: (target: string) => void,
    ) => {
      const destination = translateHref(href, session);
      if (destination.kind === 'host') {
        postToHost('navigate', { url: destination.url });
        return;
      }
      navigate(destination.href);
    };

    return {
      ...router,
      push: (href, options) => go(href, (target) => router.push(target, options)),
      replace: (href, options) => go(href, (target) => router.replace(target, options)),
      prefetch: (href, options) => {
        const destination = translateHref(href, session);
        if (destination.kind === 'embed') router.prefetch(destination.href, options);
      },
    };
  }, [router, session]);

  return (
    <AppRouterContext.Provider value={embeddedRouter}>{children}</AppRouterContext.Provider>
  );
}

export default EmbedRouterProvider;
