/**
 * "Add to calendar" row on the booking confirmation — two quiet links:
 *  - Google Calendar's render?action=TEMPLATE deep link (opens prefilled), and
 *  - a .ics download (Apple Calendar / Outlook / anything else), served through
 *    the same-origin proxy at /calendar/booking/<itemId>.ics.
 *
 * Server component: both hrefs are computed from the order — no client JS.
 */
import type { OrderLineItem } from '@/lib/api';

/** iCal/Google basic UTC stamp: YYYYMMDDTHHMMSSZ. */
function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function googleCalendarUrl(input: {
  item: OrderLineItem;
  orderNumber: string;
  brandName: string;
}): string {
  const { item, orderNumber, brandName } = input;
  const start = new Date(item.datetime);
  const minutes = item.durationMinutes > 0 ? item.durationMinutes : 60;
  const end = new Date(start.getTime() + minutes * 60_000);

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${item.activityName} — ${brandName}`,
    dates: `${utcStamp(start)}/${utcStamp(end)}`,
    details: `Order ${orderNumber} · ${item.quantity} ${item.quantity === 1 ? 'guest' : 'guests'} · ${item.rateName}`,
    location: brandName,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

const linkClass =
  'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900';

export function AddToCalendar({
  item,
  orderNumber,
  brandName,
}: {
  item: OrderLineItem;
  orderNumber: string;
  brandName: string;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
      <a
        href={googleCalendarUrl({ item, orderNumber, brandName })}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        <CalendarIcon />
        Add to Google Calendar
      </a>
      <a href={`/calendar/booking/${item.id}.ics`} className={linkClass} download>
        <DownloadIcon />
        Download .ics
      </a>
      <span className="text-xs text-slate-400">Apple Calendar &amp; Outlook use the .ics file</span>
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}
