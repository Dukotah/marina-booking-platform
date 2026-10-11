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

/** The single accent (teal-600) — the trend renders on the one accent, never a second color. */
const ACCENT = 'rgb(var(--accent))';

export interface RevenueTrendChartProps {
  data: RevenuePoint[];
  /** Accepted for call-site compatibility; the trend renders on the teal accent. */
  brandColor?: string;
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
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-ink">{row.label}</div>
      <div className="mt-0.5 text-ink-body">{formatUSD(row.cents)}</div>
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
export function RevenueTrendChart({ data }: RevenueTrendChartProps) {
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
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.28} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
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
            cursor={{ stroke: ACCENT, strokeWidth: 1, strokeOpacity: 0.3 }}
          />
          <Area
            type="monotone"
            dataKey="dollars"
            stroke={ACCENT}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 4, fill: ACCENT }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
