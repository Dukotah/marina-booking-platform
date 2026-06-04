'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatUSD } from '../../lib/format';
import type { RevenueDayPoint } from './queries';

export interface RevenueReportChartProps {
  data: RevenueDayPoint[];
  /** Operator brand color (hex) — keeps the chart white-label. */
  brandColor: string;
}

interface ChartRow {
  date: string;
  label: string;
  dollars: number;
  cents: number;
  orders: number;
}

/** Compact axis label "Jun 4" from an ISO date, parsed as local. */
function shortLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Whole-dollar axis tick "$1.2k" / "$350". */
function dollarTick(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
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
      <div className="mt-0.5 text-slate-600">{formatUSD(row.cents)}</div>
      <div className="text-slate-400">
        {row.orders} order{row.orders === 1 ? '' : 's'}
      </div>
    </div>
  );
}

/**
 * Daily gross-revenue bar chart for the selected range. Bars use the operator's
 * brand color so the report stays white-label. With no data the series is a flat
 * run of zeros and the chart renders an empty baseline rather than breaking.
 */
export function RevenueReportChart({ data, brandColor }: RevenueReportChartProps) {
  const rows = useMemo<ChartRow[]>(
    () =>
      data.map((p) => ({
        date: p.date,
        label: shortLabel(p.date),
        dollars: p.grossCents / 100,
        cents: p.grossCents,
        orders: p.orders,
      })),
    [data],
  );

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            minTickGap={16}
          />
          <YAxis
            tickFormatter={dollarTick}
            tickLine={false}
            axisLine={false}
            width={48}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            allowDecimals={false}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ fill: brandColor, fillOpacity: 0.06 }}
          />
          <Bar
            dataKey="dollars"
            fill={brandColor}
            radius={[4, 4, 0, 0]}
            maxBarSize={48}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
