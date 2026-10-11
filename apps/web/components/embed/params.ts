/**
 * URL contract for the embedded booking flow.
 *
 * The whole widget lives at a single route (`/embed`) and moves between steps by
 * changing its query string. That is deliberate: a soft navigation from
 * `/embed?step=activity` to `/embed?step=checkout` keeps the embed layout — and
 * therefore the resize/postMessage bridge — mounted the entire time, so the
 * iframe never loses contact with the host page mid-booking.
 *
 * Two groups of params:
 *   session — set once by the loader (public/embed.js) and carried through every
 *             step: which widget instance, which tenant, which activity it is
 *             pinned to, how it is being displayed.
 *   step    — the booking selection, mirroring exactly the params the standalone
 *             /checkout and /confirmation routes already accept.
 */

export type EmbedStep = 'catalog' | 'activity' | 'checkout' | 'confirmation';

const STEPS: readonly EmbedStep[] = ['catalog', 'activity', 'checkout', 'confirmation'];

/** Session params, constant for the life of one widget instance. */
export interface EmbedSessionParams {
  /** Widget instance id from the loader; echoed on every postMessage. */
  eid: string;
  /** Operator slug from `data-operator` (the host name is the canonical source). */
  operator: string;
  /** Activity the widget is pinned to via `data-activity`, if any. */
  activity: string;
  /** True when pinned — the flow then hides "browse all activities". */
  locked: boolean;
  /** How the host is displaying us; drives the close button and surface styling. */
  mode: 'inline' | 'modal';
  /** Optional accent override (`data-color`), already validated as a hex color. */
  accent: string;
}

/** The full parsed URL state for one render of /embed. */
export interface EmbedParams extends EmbedSessionParams {
  step: EmbedStep;
  /** The activity currently being booked (pinned activity, or one picked from the catalog). */
  activityId: string;
  rateId: string;
  timeslotId: string;
  date: string;
  quantity: string;
  order: string;
  /** Identity proof for the confirmation lookup (the order API gates on it). */
  email: string;
}

/** A single query value regardless of whether Next handed us a string or array. */
export type RawParams = Record<string, string | string[] | undefined>;

export function firstParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Accept only `#rgb` / `#rrggbb` so a crafted URL cannot inject CSS. */
export function safeAccent(value: string): string {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : '';
}

/**
 * Slugs are operator identifiers, not free text. Rejecting anything else keeps a
 * crafted `?operator=` out of the cookie we hand to the API client.
 */
export function safeSlug(value: string): string {
  return /^[a-z0-9][a-z0-9-]{0,62}$/i.test(value) ? value : '';
}

function isStep(value: string): value is EmbedStep {
  return (STEPS as readonly string[]).indexOf(value) !== -1;
}

export function parseEmbedParams(raw: RawParams): EmbedParams {
  const pinned = firstParam(raw.activity);
  const activityId = firstParam(raw.activityId) || pinned;
  const requested = firstParam(raw.step);

  // No explicit step: a pinned widget opens straight on its activity (the
  // `data-activity` deep link), everything else opens on the catalog.
  const step: EmbedStep = isStep(requested)
    ? requested
    : activityId
      ? 'activity'
      : 'catalog';

  return {
    eid: firstParam(raw.eid).slice(0, 64),
    operator: safeSlug(firstParam(raw.operator)),
    activity: pinned,
    locked: firstParam(raw.locked) === '1' && pinned !== '',
    mode: firstParam(raw.mode) === 'inline' ? 'inline' : 'modal',
    accent: safeAccent(firstParam(raw.accent)),
    step,
    activityId,
    rateId: firstParam(raw.rateId),
    timeslotId: firstParam(raw.timeslotId),
    date: firstParam(raw.date),
    quantity: firstParam(raw.quantity),
    order: firstParam(raw.order),
    email: firstParam(raw.email),
  };
}

/** Read the same shape out of a browser URL (used by the router bridge). */
export function parseEmbedSearch(search: string | URLSearchParams): EmbedParams {
  const sp = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw: RawParams = {};
  sp.forEach((value, key) => {
    if (raw[key] === undefined) raw[key] = value;
  });
  return parseEmbedParams(raw);
}

/** Build an `/embed?…` href for a step, carrying the session params forward. */
export function buildEmbedHref(
  session: EmbedSessionParams,
  step: EmbedStep,
  extra: Record<string, string | undefined> = {},
): string {
  const sp = new URLSearchParams();

  if (session.eid) sp.set('eid', session.eid);
  if (session.operator) sp.set('operator', session.operator);
  if (session.activity) sp.set('activity', session.activity);
  if (session.locked) sp.set('locked', '1');
  sp.set('mode', session.mode);
  if (session.accent) sp.set('accent', session.accent);
  sp.set('step', step);

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') sp.set(key, value);
  }

  return `/embed?${sp.toString()}`;
}

/**
 * Where "back" leads from each step.
 *
 * Checkout returns to the activity so a customer can change date or time without
 * abandoning the widget. A pinned widget (`data-activity`) never offers the
 * catalog, because it does not have one — an unreachable "all activities" link
 * would be a dead end on the operator's page.
 *
 * Lives here rather than in EmbedShell so the server route can call it; a value
 * exported from a `'use client'` module is only a client reference on the server.
 */
export function backTarget(
  session: EmbedSessionParams,
  step: EmbedStep,
  activityId: string,
): { href: string; label: string } | null {
  if (step === 'catalog' || step === 'confirmation') return null;

  const catalogTarget = session.locked
    ? null
    : { href: buildEmbedHref(session, 'catalog'), label: 'All activities' };

  if (step === 'activity') return catalogTarget;

  if (activityId) {
    return {
      href: buildEmbedHref(session, 'activity', { activityId }),
      label: 'Change date or time',
    };
  }
  return catalogTarget;
}
