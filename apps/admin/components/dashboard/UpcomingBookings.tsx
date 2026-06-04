import { CalendarClock } from 'lucide-react';
import { Badge, EmptyState } from '@marina/ui';
import { formatRelative, formatUSD } from '../../lib/format';
import type { UpcomingBooking } from './queries';

export interface UpcomingBookingsProps {
  bookings: UpcomingBooking[];
}

/** Initials for the avatar chip ("Jane Doe" -> "JD"). */
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '–'
  );
}

/**
 * The next upcoming bookings feed. Each row shows who, what, when, party size,
 * order value, and a waiver-status chip so staff can prep. Empty renders a
 * friendly placeholder (no seed data yet).
 */
export function UpcomingBookings({ bookings }: UpcomingBookingsProps) {
  if (bookings.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="No upcoming bookings"
        description="New reservations will appear here as they come in."
      />
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-slate-100">
      {bookings.map((b) => (
        <li key={b.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white"
            aria-hidden
          >
            {initials(b.customerName)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-slate-900">
                {b.customerName}
              </span>
              {b.waiverSigned ? (
                <Badge variant="success">Waiver</Badge>
              ) : (
                <Badge variant="warning">No waiver</Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-sm text-slate-500">
              {b.activityName} · party of {b.quantity} · {b.orderNumber}
            </p>
          </div>

          <div className="shrink-0 text-right">
            <div className="text-sm font-medium text-slate-900">
              {formatUSD(b.totalCents)}
            </div>
            <div className="text-xs text-slate-400">{formatRelative(b.datetime)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
