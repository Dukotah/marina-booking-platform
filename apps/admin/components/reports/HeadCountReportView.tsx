import { CalendarDays, Ship, Users, UsersRound } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatNumber } from '../../lib/format';
import type { HeadCountReport } from './queries';

export interface HeadCountReportViewProps {
  report: HeadCountReport;
}

const CELL = 'px-3 py-2 tabular-nums text-right';
const CELL_LEFT = 'px-3 py-2 text-left';

/**
 * Head Count / booking summary: how many PEOPLE are on the water each day,
 * from manifest data — seat lines only (add-ons excluded), keyed by the
 * scheduled timeslot date. Days with zero guests still render, so gaps in the
 * season are visible rather than hidden.
 */
export function HeadCountReportView({ report }: HeadCountReportViewProps) {
  if (report.totals.guests === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No guests scheduled in this range"
        description="Guest counts appear here for days with scheduled bookings."
      />
    );
  }

  // Hide leading/trailing all-zero noise is NOT done — a zero day is signal.
  const busiest = report.daily.reduce(
    (max, d) => (d.guests > max.guests ? d : max),
    report.daily[0]!,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Guests" value={formatNumber(report.totals.guests)} icon={Users} />
        <KpiCard label="Bookings" value={formatNumber(report.totals.bookings)} icon={Ship} />
        <KpiCard
          label="Avg party size"
          value={report.totals.avgPartySize.toFixed(1)}
          icon={UsersRound}
        />
        <KpiCard
          label="Busiest day"
          value={busiest.guests > 0 ? `${busiest.date} · ${formatNumber(busiest.guests)}` : '—'}
          icon={CalendarDays}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Guests by activity</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium uppercase tracking-wide text-slate-500">
                  <th className={CELL_LEFT}>Activity</th>
                  <th className={CELL}>Guests</th>
                  <th className={CELL}>Bookings</th>
                  <th className={CELL}>Avg party</th>
                </tr>
              </thead>
              <tbody>
                {report.byActivity.map((a) => (
                  <tr key={a.activityId} className="border-t border-slate-50">
                    <td className={CELL_LEFT}>
                      <span className="flex items-center gap-2 font-medium text-slate-800">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: a.color }}
                          aria-hidden
                        />
                        {a.activityName}
                      </span>
                    </td>
                    <td className={`${CELL} text-slate-700`}>{formatNumber(a.guests)}</td>
                    <td className={`${CELL} text-slate-700`}>{formatNumber(a.bookings)}</td>
                    <td className={`${CELL} text-slate-500`}>{a.avgPartySize.toFixed(1)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-200 font-semibold text-slate-900">
                  <td className={CELL_LEFT}>Total</td>
                  <td className={CELL}>{formatNumber(report.totals.guests)}</td>
                  <td className={CELL}>{formatNumber(report.totals.bookings)}</td>
                  <td className={CELL}>{report.totals.avgPartySize.toFixed(1)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Guests by day</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium uppercase tracking-wide text-slate-500">
                    <th className={CELL_LEFT}>Date</th>
                    <th className={CELL}>Guests</th>
                    <th className={CELL}>Bookings</th>
                  </tr>
                </thead>
                <tbody>
                  {report.daily.map((d) => (
                    <tr key={d.date} className="border-t border-slate-50">
                      <td className={`${CELL_LEFT} tabular-nums text-slate-600`}>{d.date}</td>
                      <td className={`${CELL} ${d.guests ? 'text-slate-800' : 'text-slate-300'}`}>
                        {formatNumber(d.guests)}
                      </td>
                      <td className={`${CELL} ${d.bookings ? 'text-slate-700' : 'text-slate-300'}`}>
                        {formatNumber(d.bookings)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
