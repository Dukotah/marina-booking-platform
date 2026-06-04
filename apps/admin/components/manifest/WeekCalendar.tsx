import Link from 'next/link';
import { cn } from '../../lib/cn';
import { formatTime } from '../../lib/format';
import { readableTextColor } from './types';
import { statusStyle } from './status';
import { blockGeometry, hourTicks, deriveWindow, type DayWindow } from './time';

/**
 * A real week grid (not a flat list) of bookings. Seven day columns share one
 * vertical time axis; each booking renders as a color-coded block positioned by its
 * start/end within the day. This is the calendar counterpart to the Gantt manifest —
 * same visual language, zoomed out to a week. Clicking a block deep-links to its order.
 */
export interface WeekCalendarEvent {
  orderItemId: string;
  orderId: string;
  orderNumber: string;
  /** 0-6 index of the day column (0 = first day of the week). */
  dayIndex: number;
  startMin: number;
  endMin: number;
  startISO: string;
  title: string;
  subtitle: string;
  color: string;
  status: import('@marina/database').OrderItemStatus;
}

export interface WeekCalendarDay {
  /** YYYY-MM-DD for this column. */
  iso: string;
  /** Short weekday label, e.g. "Mon". */
  weekday: string;
  /** Day-of-month number, e.g. "4". */
  dayNum: string;
  isToday: boolean;
}

export interface WeekCalendarProps {
  days: WeekCalendarDay[];
  events: WeekCalendarEvent[];
}

const HOUR_PX = 52; // vertical pixels per hour

export function WeekCalendar({ days, events }: WeekCalendarProps) {
  const win = deriveWindow(
    events.map((e) => ({ startMin: e.startMin, endMin: e.endMin })),
    { startHour: 7, endHour: 21 },
  );
  const ticks = hourTicks(win);
  const gridHeight = (win.endHour - win.startHour) * HOUR_PX;

  const eventsByDay: WeekCalendarEvent[][] = days.map(() => []);
  for (const ev of events) {
    if (ev.dayIndex >= 0 && ev.dayIndex < days.length) eventsByDay[ev.dayIndex].push(ev);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Day headers */}
      <div className="flex border-b border-slate-200 bg-slate-50">
        <div className="w-14 shrink-0" />
        {days.map((d) => (
          <div
            key={d.iso}
            className={cn(
              'flex-1 border-l border-slate-100 px-2 py-2 text-center',
              d.isToday && 'bg-sky-50',
            )}
          >
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              {d.weekday}
            </div>
            <div
              className={cn(
                'mx-auto mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold',
                d.isToday ? 'bg-sky-600 text-white' : 'text-slate-700',
              )}
            >
              {d.dayNum}
            </div>
          </div>
        ))}
      </div>

      {/* Time grid */}
      <div className="flex overflow-x-auto">
        {/* Hour gutter */}
        <div className="w-14 shrink-0" style={{ height: gridHeight }}>
          <div className="relative h-full">
            {ticks.slice(0, -1).map((t) => (
              <div
                key={t.hour}
                className="absolute right-2 -translate-y-1/2 text-[11px] font-medium text-slate-400"
                style={{ top: ((t.hour - win.startHour) * HOUR_PX) }}
              >
                {t.label}
              </div>
            ))}
          </div>
        </div>

        {/* Day columns */}
        {days.map((d, dayIdx) => (
          <DayColumn
            key={d.iso}
            day={d}
            events={eventsByDay[dayIdx]}
            win={win}
            ticks={ticks}
            gridHeight={gridHeight}
          />
        ))}
      </div>
    </div>
  );
}

function DayColumn({
  day,
  events,
  win,
  ticks,
  gridHeight,
}: {
  day: WeekCalendarDay;
  events: WeekCalendarEvent[];
  win: DayWindow;
  ticks: ReturnType<typeof hourTicks>;
  gridHeight: number;
}) {
  const lanes = assignColumnLanes(events);

  return (
    <div
      className={cn('relative flex-1 border-l border-slate-100', day.isToday && 'bg-sky-50/40')}
      style={{ height: gridHeight }}
    >
      {/* Hour lines */}
      {ticks.map((t) => (
        <div
          key={t.hour}
          className="absolute inset-x-0 border-t border-slate-100"
          style={{ top: (t.hour - win.startHour) * HOUR_PX }}
        />
      ))}

      {/* Events */}
      {lanes.map(({ event, lane, laneCount }) => {
        // Skip anything that falls entirely outside the visible window.
        if (!blockGeometry(event.startMin, event.endMin, win)) return null;
        const top = ((event.startMin - win.startHour * 60) / 60) * HOUR_PX;
        const height = Math.max(
          18,
          ((Math.min(event.endMin, win.endHour * 60) - event.startMin) / 60) * HOUR_PX - 2,
        );
        const widthPct = 100 / laneCount;
        const leftPct = lane * widthPct;
        const fg = readableTextColor(event.color);
        const muted = statusStyle(event.status).muted;

        return (
          <Link
            key={event.orderItemId}
            href={`/orders/${event.orderId}`}
            title={`${event.title} · ${formatTime(event.startISO)} · ${event.subtitle}`}
            className={cn(
              'absolute overflow-hidden rounded-md border border-black/10 px-1.5 py-1 text-[11px] leading-tight shadow-sm transition-shadow hover:z-10 hover:shadow-md',
              muted && 'opacity-60 saturate-50',
            )}
            style={{
              top,
              height,
              left: `calc(${leftPct}% + 2px)`,
              width: `calc(${widthPct}% - 4px)`,
              backgroundColor: event.color,
              color: fg,
            }}
          >
            <div className="truncate font-semibold">{formatTime(event.startISO)}</div>
            <div className="truncate opacity-95">{event.title}</div>
            {height > 36 ? <div className="truncate opacity-80">{event.subtitle}</div> : null}
          </Link>
        );
      })}

      {events.length === 0 ? (
        <div className="pointer-events-none absolute inset-x-0 top-2 text-center text-[11px] text-slate-300">
          —
        </div>
      ) : null}
    </div>
  );
}

/**
 * Greedy lane assignment within a single day column so overlapping events split the
 * column width instead of stacking on top of each other.
 */
function assignColumnLanes(
  events: WeekCalendarEvent[],
): Array<{ event: WeekCalendarEvent; lane: number; laneCount: number }> {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const laneEnds: number[] = [];
  const placed: Array<{ event: WeekCalendarEvent; lane: number }> = [];

  for (const event of sorted) {
    let lane = laneEnds.findIndex((end) => event.startMin >= end);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(event.endMin);
    } else {
      laneEnds[lane] = event.endMin;
    }
    placed.push({ event, lane });
  }

  const laneCount = Math.max(1, laneEnds.length);
  return placed.map((p) => ({ ...p, laneCount }));
}
