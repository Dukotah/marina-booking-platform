'use client';

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatUSD } from '../../lib/format';
import type { RevenuePoint } from './queries';

export interface RevenueTrendChartProps {
  data: RevenuePoint[];
  /** Operator brand color (hex) — keeps the chart white-label. */
  brandColor: string;
}

interface ChartRow {
  date: string;
  label: string;
  dollars: number;
  cents: number;
}

/** Compact axis label: "Jun 4". Parses the ISO date as a local date. */
function shortLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Whole-dollar axis tick: "$1.2k" / "$350". */
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
    </div>
  );
}

/**
 * Revenue trend area chart. Renders client-side (recharts is interactive). The
 * accent color is the operator's brand color so the chart stays white-label.
 *
 * With no seed data the series is a flat run of zeros — the chart still renders
 * an empty baseline rather than breaking.
 */
export function RevenueTrendChart({ data, brandColor }: RevenueTrendChartProps) {
  const rows = useMemo<ChartRow[]>(
    () =>
      data.map((p) => ({
        date: p.date,
        label: shortLabel(p.date),
        dollars: p.cents / 100,
        cents: p.cents,
      })),
    [data],
  );

  const gradientId = 'revenue-trend-fill';

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={brandColor} stopOpacity={0.28} />
              <stop offset="100%" stopColor={brandColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
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
            cursor={{ stroke: brandColor, strokeWidth: 1, strokeOpacity: 0.3 }}
          />
          <Area
            type="monotone"
            dataKey="dollars"
            stroke={brandColor}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 4, fill: brandColor }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
