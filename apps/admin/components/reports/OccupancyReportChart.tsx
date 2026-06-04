'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { OccupancyReport } from './queries';

export interface OccupancyReportChartProps {
  data: OccupancyReport['daily'];
  /** Operator brand color (hex) — keeps the chart white-label. */
  brandColor: string;
}

interface ChartRow {
  date: string;
  label: string;
  /** Occupancy percent (0–100) for the day. */
  percent: number;
  capacityBooked: number;
  capacityTotal: number;
}

function shortLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-slate-900">{row.label}</div>
      <div className="mt-0.5 text-slate-600">{row.percent.toFixed(0)}% occupancy</div>
      <div className="text-slate-400">
        {row.capacityBooked}/{row.capacityTotal} seats
      </div>
    </div>
  );
}

/**
 * Daily occupancy line chart (booked / total capacity, as a percentage) for the
 * selected range. The line uses the operator's brand color for white-label, and
 * the Y axis is pinned to 0–100% so trends read consistently across ranges.
 */
export function OccupancyReportChart({ data, brandColor }: OccupancyReportChartProps) {
  const rows = useMemo<ChartRow[]>(
    () =>
      data.map((p) => ({
        date: p.date,
        label: shortLabel(p.date),
        percent: Math.round(p.ratio * 100),
        capacityBooked: p.capacityBooked,
        capacityTotal: p.capacityTotal,
      })),
    [data],
  );

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            minTickGap={16}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tickLine={false}
            axisLine={false}
            width={44}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            allowDecimals={false}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: brandColor, strokeWidth: 1, strokeOpacity: 0.3 }}
          />
          <Line
            type="monotone"
            dataKey="percent"
            stroke={brandColor}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: brandColor }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
