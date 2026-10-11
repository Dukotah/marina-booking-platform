import type { RuleView } from './schedule-rules-actions';

/**
 * Shape a stored ScheduleRule row into the view the component renders.
 *
 * Lives in a plain module (not the `'use server'` actions file) because Next
 * requires every runtime export of a server-actions module to be an async
 * function — this synchronous mapper isn't an action.
 */
export function toRuleView(r: {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  weekdays: number[];
  start_minutes: number[];
  open_minute: number | null;
  close_minute: number | null;
  capacity: number | null;
  is_active: boolean;
}): RuleView {
  // A rental-window rule is one with both edges set and no fixed departures.
  const isRental =
    r.open_minute !== null && r.close_minute !== null && r.start_minutes.length === 0;
  return {
    id: r.id,
    kind: isRental ? 'rental' : 'departures',
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    weekdays: r.weekdays,
    startMinutes: r.start_minutes,
    openMinute: r.open_minute,
    closeMinute: r.close_minute,
    capacity: r.capacity,
    isActive: r.is_active,
  };
}
