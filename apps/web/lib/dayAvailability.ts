/**
 * Shared per-day availability cache (client side).
 *
 * Extracted from TimeSlotPicker so the date strip can refine "today" with
 * slot-level truth (which departures are still ahead of the clock) without a
 * second copy of the cache — the picker and the calendar now share one fetch
 * per (activity, day).
 *
 * The TTL is deliberately short. "Availability that never lies"
 * (docs/LOCAL-FIRST-BUILD.md §6) outranks the round trip this saves: capacity
 * is live inventory and another guest can take the last seat at any moment.
 * Thirty seconds makes flicking between two days feel instant while nothing a
 * guest sees is meaningfully older than the page. It is not a correctness
 * boundary either way — the booking call re-checks capacity server-side.
 */
import { getAvailability, isApiError, type AvailabilitySlot } from '@/lib/api';

const DAY_TTL_MS = 30_000;

interface CachedDay {
  slots: AvailabilitySlot[];
  fetchedAt: number;
}

const dayCache = new Map<string, CachedDay>();
/** Requests currently on the wire, so two mounts of the same day cost one. */
const inFlight = new Map<string, Promise<AvailabilitySlot[]>>();

function cacheKey(activityId: string, iso: string): string {
  return `${activityId}|${iso}`;
}

/** Cached slots for a day, or null when nothing fresh is held. */
export function readCachedDay(activityId: string, iso: string): AvailabilitySlot[] | null {
  const hit = dayCache.get(cacheKey(activityId, iso));
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > DAY_TTL_MS) {
    dayCache.delete(cacheKey(activityId, iso));
    return null;
  }
  return hit.slots;
}

/**
 * Load one day's slots, sharing an in-flight request and caching the result.
 *
 * A 404 means "this activity has no schedule that day", which is an answer
 * rather than a failure, so it caches as an empty day instead of being retried
 * on every re-render.
 */
export async function loadDay(activityId: string, iso: string): Promise<AvailabilitySlot[]> {
  const key = cacheKey(activityId, iso);
  const cached = readCachedDay(activityId, iso);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const day = await getAvailability(activityId, iso);
      // Stable order by start time.
      const sorted = [...day.slots].sort(
        (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime(),
      );
      dayCache.set(key, { slots: sorted, fetchedAt: Date.now() });
      return sorted;
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        dayCache.set(key, { slots: [], fetchedAt: Date.now() });
        return [];
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, pending);
  return pending;
}
