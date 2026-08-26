/**
 * The postMessage contract between the embedded booking flow (this app, inside
 * an iframe) and the operator's own page (running public/embed.js).
 *
 * Both halves of the protocol live in two files on purpose — the loader has to be
 * dependency-free ES5 that runs on somebody else's site, and this half is part of
 * the app bundle. Keep the constants below in sync with `public/embed.js`; the
 * `v` field exists so a stale cached loader is ignored rather than half-honoured.
 *
 * Direction of travel:
 *   frame → host   ready · resize · step · close · booking-completed · navigate
 *   host  → frame  host (the handshake that tells us the host's origin)
 *
 * Until the handshake lands we only know the host is "whoever framed us", so
 * non-sensitive messages go out with a `*` target and anything carrying booking
 * detail is queued until we can address a specific origin.
 */

export const EMBED_PROTOCOL = 'marina-embed';
export const EMBED_PROTOCOL_VERSION = 1;

/** Messages this frame sends up to the operator's page. */
export type EmbedOutboundType =
  | 'ready'
  | 'resize'
  | 'step'
  | 'close'
  | 'booking-completed'
  | 'navigate';

export interface EmbedEnvelope<T = Record<string, unknown>> {
  source: typeof EMBED_PROTOCOL;
  v: number;
  /** The widget instance id, echoed from the `eid` query param. */
  id: string;
  type: string;
  payload: T;
}

/** Payload of the `booking-completed` event an operator's analytics listens for. */
export interface BookingCompletedPayload extends Record<string, unknown> {
  orderNumber: string;
  totalCents: number;
  currency: 'USD';
  guests: number;
  activityIds: string[];
  activityNames: string[];
}

/** Messages whose payload should only ever reach a known origin. */
const TARGETED: ReadonlySet<string> = new Set(['booking-completed']);

/** How long a targeted message waits for the handshake before giving up on it. */
const HANDSHAKE_GRACE_MS = 3000;

interface Pending {
  type: EmbedOutboundType;
  payload: Record<string, unknown>;
  queuedAt: number;
}

let instanceId = '';
let hostOrigin: string | null = null;
let pending: Pending[] = [];

/** True when this document is actually running inside a frame. */
export function isFramed(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    // A cross-origin parent can throw on access in older engines; being unable to
    // compare means we are framed.
    return true;
  }
}

export function setInstanceId(id: string): void {
  instanceId = id;
}

/** Record the host origin from the handshake and flush anything held back. */
export function setHostOrigin(origin: string): void {
  if (!origin || hostOrigin === origin) return;
  hostOrigin = origin;
  const queued = pending;
  pending = [];
  for (const message of queued) send(message.type, message.payload);
}

function send(type: EmbedOutboundType, payload: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !isFramed()) return;
  const envelope: EmbedEnvelope = {
    source: EMBED_PROTOCOL,
    v: EMBED_PROTOCOL_VERSION,
    id: instanceId,
    type,
    payload,
  };
  window.parent.postMessage(envelope, hostOrigin ?? '*');
}

/**
 * Send a message to the host page. Booking detail waits for the handshake, but
 * only briefly: an operator's conversion tracking failing silently is worse than
 * addressing the parent window without pinning its origin, and `postMessage`
 * delivers to the parent window either way — `*` only relaxes the origin check.
 */
export function postToHost(
  type: EmbedOutboundType,
  payload: Record<string, unknown> = {},
): void {
  if (typeof window === 'undefined' || !isFramed()) return;

  if (TARGETED.has(type) && !hostOrigin) {
    pending.push({ type, payload, queuedAt: Date.now() });
    window.setTimeout(() => {
      const stale = pending.filter((m) => Date.now() - m.queuedAt >= HANDSHAKE_GRACE_MS);
      if (stale.length === 0) return;
      pending = pending.filter((m) => stale.indexOf(m) === -1);
      for (const message of stale) send(message.type, message.payload);
    }, HANDSHAKE_GRACE_MS);
    return;
  }

  send(type, payload);
}

/** Narrow an arbitrary `message` event to a valid host→frame envelope. */
export function readHostEnvelope(data: unknown): EmbedEnvelope | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Partial<EmbedEnvelope>;
  if (candidate.source !== EMBED_PROTOCOL) return null;
  if (candidate.v !== EMBED_PROTOCOL_VERSION) return null;
  if (typeof candidate.type !== 'string') return null;
  if (instanceId && candidate.id !== instanceId) return null;
  return {
    source: EMBED_PROTOCOL,
    v: EMBED_PROTOCOL_VERSION,
    id: String(candidate.id ?? ''),
    type: candidate.type,
    payload: (candidate.payload ?? {}) as Record<string, unknown>,
  };
}
