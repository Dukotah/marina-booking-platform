'use client';

import { useEffect, useState } from 'react';
import { localMinutesOfDay, todayIsoIn } from './tz';

/**
 * Operator-local "now", resolved after mount (so server and client markup agree)
 * and ticked each minute. Returns null until mounted. Mirrors the inline clock the
 * Day view runs on (DaySchedule), lifted so the Timeline's "now" line shares it.
 */
export function useNowMinute(timeZone: string): { isoDate: string; minutes: number } | null {
  const [now, setNow] = useState<{ isoDate: string; minutes: number } | null>(null);
  useEffect(() => {
    function tick() {
      setNow({ isoDate: todayIsoIn(timeZone), minutes: localMinutesOfDay(new Date(), timeZone) });
    }
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [timeZone]);
  return now;
}
