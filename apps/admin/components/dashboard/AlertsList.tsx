import { AlertTriangle, FileWarning, ShieldCheck, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EmptyState } from '@marina/ui';
import { formatRelative } from '../../lib/format';
import type { DashboardAlert } from './queries';

export interface AlertsListProps {
  alerts: DashboardAlert[];
}

interface AlertStyle {
  icon: LucideIcon;
  iconWrap: string;
}

const STYLES: Record<DashboardAlert['kind'], AlertStyle> = {
  UNSIGNED_WAIVER: {
    icon: FileWarning,
    iconWrap: 'bg-amber-100 text-amber-700',
  },
  LOW_CAPACITY: {
    icon: Users,
    iconWrap: 'bg-sky-100 text-sky-700',
  },
};

/**
 * Operational alerts feed: unsigned waivers on imminent bookings and slots
 * running low/full. When there's nothing to act on, an all-clear empty state
 * reassures the operator rather than showing a blank box.
 */
export function AlertsList({ alerts }: AlertsListProps) {
  if (alerts.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="All clear"
        description="No unsigned waivers or capacity warnings right now."
      />
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-slate-100">
      {alerts.map((a) => {
        const style = STYLES[a.kind] ?? {
          icon: AlertTriangle,
          iconWrap: 'bg-slate-100 text-slate-600',
        };
        const Icon = style.icon;
        return (
          <li key={a.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <span
              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.iconWrap}`}
              aria-hidden
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">{a.title}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {formatRelative(a.at)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-sm text-slate-500">{a.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
