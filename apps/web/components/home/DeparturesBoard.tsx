/**
 * "Today's Departures" — the availability-first board that leads the homepage
 * (DESIGN.md "Speed mechanics" #1: availability is displayed, never queried).
 *
 * A 7-day rail (server-rendered links; selecting a day is a plain `?date=`
 * navigation, no client state) above a surface board of the day's next
 * bookable departures: time · activity · seats left · all-in price · Reserve.
 * Soonest first; the first Reserve is reachable without scrolling.
 *
 * All prices come from the API already all-in (the same number checkout
 * charges); every deciding number renders tabular. Estate styling throughout:
 * one surface card, hairline separators, sage reserved for Reserve + the
 * selected day. Server component — zero hydration cost.
 *
 * Deep link: Reserve goes to the activity detail page. The detail page does
 * not read date/slot query params today, so the closest supported deep-link is
 * the plain detail URL (its strip already opens on today).
 */
import Link from 'next/link';
import type { DeparturesBoard as BoardData, DepartureRailDay, DepartureRow } from '@/lib/api';
import { formatUSD } from '@/lib/format';

interface DeparturesBoardProps {
  board: BoardData;
  /** The day the board is showing, YYYY-MM-DD (= board.date). */
  selectedDate: string;
}

/** "8:00 AM" for a UTC instant, rendered in the operator's timezone. */
function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Weekday ("Mon") + short date ("Sep 8") for a YYYY-MM-DD calendar day. */
function dayLabels(isoDay: string, todayIso: string): { top: string; bottom: string } {
  const [y, m, d] = isoDay.split('-').map(Number);
  // Noon UTC so the label never slips a calendar day in any renderer locale.
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12));
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(dt);
  const short = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
  const diff =
    (Date.parse(`${isoDay}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000;
  return { top: diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : weekday, bottom: short };
}

function DayRail({
  days,
  selectedDate,
  todayIso,
}: {
  days: DepartureRailDay[];
  selectedDate: string;
  todayIso: string;
}) {
  return (
    <nav aria-label="Choose a day" className="day-strip no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {days.map((day) => {
        const selected = day.date === selectedDate;
        const { top, bottom } = dayLabels(day.date, todayIso);
        return (
          <Link
            key={day.date}
            href={day.date === todayIso ? '/' : `/?date=${day.date}`}
            aria-current={selected ? 'date' : undefined}
            className={`flex min-w-[92px] flex-col items-center gap-0.5 rounded-lg border px-3 py-2.5 transition-colors ${
              selected
                ? 'border-accent bg-surface'
                : 'border-hairline bg-surface hover:border-accent'
            }`}
          >
            <span
              className={`text-[13px] font-semibold ${selected ? 'text-accent-ink' : 'text-ink'}`}
            >
              {top}
            </span>
            <span className="text-[13px] text-muted">{bottom}</span>
            <span className={`tnum text-[13px] ${selected ? 'text-accent-ink' : 'text-muted'}`}>
              {day.available && day.minAllInCents != null
                ? `from ${formatUSD(day.minAllInCents)}`
                : '—'}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

function BoardRow({ row, timeZone }: { row: DepartureRow; timeZone: string }) {
  const lowSeats = row.seatsLeft <= 2;
  return (
    <li>
      <Link
        href={`/activities/${encodeURIComponent(row.activityId)}`}
        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg sm:gap-4 sm:px-6"
      >
        {/* Departure time — the guest's first scan column. */}
        <span className="tnum w-[62px] shrink-0 text-[15px] font-semibold text-ink sm:w-[74px] sm:text-base">
          {timeLabel(row.datetime, timeZone)}
        </span>

        {/* 1:1 thumb (photos keep the card radius even at thumb size). */}
        {row.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant photos from arbitrary origins
          <img
            src={row.photoUrl}
            alt=""
            loading="lazy"
            className="hidden h-12 w-12 shrink-0 rounded-[10px] object-cover sm:block"
          />
        ) : (
          <span aria-hidden className="hidden h-12 w-12 shrink-0 rounded-[10px] bg-bg sm:block" />
        )}

        {/* Activity + rate meta. */}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-ink sm:text-base">
            {row.activityName}
          </span>
          <span className="block text-[13px] text-muted">{row.rateName}</span>
        </span>

        {/* Seats — a fact, not urgency theater; warn tone only when truly low. */}
        <span
          className={`tnum hidden w-20 shrink-0 text-right text-sm sm:block ${
            lowSeats ? 'font-medium text-warn' : 'text-muted'
          }`}
        >
          {row.seatsLeft} {row.seatsLeft === 1 ? 'seat' : 'seats'}
        </span>

        {/* All-in price. */}
        <span className="tnum shrink-0 text-right text-[15px] font-semibold text-ink sm:w-[84px] sm:text-base">
          {formatUSD(row.allInCents)}
        </span>

        {/* The one sage action per view lives in this column. */}
        <span className="hidden shrink-0 rounded-lg bg-accent px-4 py-2 text-[15px] font-semibold text-white transition-opacity group-hover:opacity-90 sm:block">
          Reserve
        </span>
        <span aria-hidden className="text-accent-ink sm:hidden">
          →
        </span>
      </Link>
    </li>
  );
}

export function DeparturesBoard({ board, selectedDate }: DeparturesBoardProps) {
  const todayIso = board.days[0]?.date ?? selectedDate;
  const isToday = selectedDate === todayIso;
  const nextDay = board.days.find((d) => d.date > selectedDate && d.available);
  const heading = isToday
    ? "Today's departures"
    : `Departures ${dayLabels(selectedDate, todayIso).top === 'Tomorrow' ? 'tomorrow' : `on ${dayLabels(selectedDate, todayIso).bottom}`}`;

  return (
    <section aria-labelledby="departures-heading">
      <h2
        id="departures-heading"
        className="font-display text-[22px] tracking-[0.02em] text-ink"
      >
        {heading}
      </h2>
      <p className="mt-1 text-sm text-muted">
        Prices are all-in — taxes and fees included. Reserve in under a minute.
      </p>

      <div className="mt-6">
        <DayRail days={board.days} selectedDate={selectedDate} todayIso={todayIso} />
      </div>

      <div className="mt-4 overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
        {board.departures.length === 0 ? (
          /* Empty state: one sentence + one action. */
          <div className="px-6 py-14 text-center">
            <p className="text-base text-ink">
              No more departures {isToday ? 'today' : 'on this day'}.
            </p>
            {nextDay ? (
              <Link
                href={`/?date=${nextDay.date}`}
                className="mt-2 inline-block text-sm font-semibold text-accent-ink hover:underline"
              >
                See {dayLabels(nextDay.date, todayIso).top === 'Tomorrow' ? 'tomorrow' : dayLabels(nextDay.date, todayIso).bottom} →
              </Link>
            ) : (
              <p className="mt-2 text-sm text-muted">Check back soon for new times.</p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {board.departures.map((row) => (
              <BoardRow key={row.timeslotId} row={row} timeZone={board.timezone} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default DeparturesBoard;
