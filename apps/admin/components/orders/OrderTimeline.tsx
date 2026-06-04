import {
  CalendarPlus,
  Ban,
  CreditCard,
  Undo2,
  Mail,
  CheckCircle2,
  Clock,
  type LucideIcon,
} from 'lucide-react';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/cn';

export interface TimelineEvent {
  id: string;
  type: string;
  description: string;
  actor: string | null;
  createdAt: Date | string;
}

/** Map an OrderEvent.type to an icon + accent. Unknown types fall back neutrally. */
function eventVisual(type: string): { icon: LucideIcon; className: string } {
  switch (type) {
    case 'ORDER_CREATED':
      return { icon: CalendarPlus, className: 'bg-sky-50 text-sky-600 ring-sky-600/20' };
    case 'ORDER_CANCELLED':
      return { icon: Ban, className: 'bg-slate-100 text-slate-500 ring-slate-500/20' };
    case 'PAYMENT':
      return { icon: CreditCard, className: 'bg-emerald-50 text-emerald-600 ring-emerald-600/20' };
    case 'REFUND':
      return { icon: Undo2, className: 'bg-amber-50 text-amber-600 ring-amber-600/20' };
    case 'EMAIL_RESENT':
      return { icon: Mail, className: 'bg-indigo-50 text-indigo-600 ring-indigo-600/20' };
    case 'CHECKED_IN':
    case 'COMPLETED':
      return { icon: CheckCircle2, className: 'bg-emerald-50 text-emerald-600 ring-emerald-600/20' };
    default:
      return { icon: Clock, className: 'bg-slate-100 text-slate-500 ring-slate-500/20' };
  }
}

/** Human-friendly actor label. The booking service uses "customer"/staff ids. */
function actorLabel(actor: string | null): string {
  if (!actor) return 'System';
  if (actor === 'customer') return 'Customer';
  if (actor === 'dev-owner') return 'Owner';
  return actor;
}

/**
 * Vertical audit timeline of OrderEvents — the full history of an order (created,
 * paid, refunded, cancelled, emails). Replaces Singenuity's opaque manifest with
 * a clear, chronological record staff can trust.
 */
export function OrderTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-slate-500">No activity recorded yet.</p>;
  }

  return (
    <ol className="space-y-0">
      {events.map((event, index) => {
        const { icon: Icon, className } = eventVisual(event.type);
        const isLast = index === events.length - 1;
        return (
          <li key={event.id} className="relative flex gap-3 pb-6 last:pb-0">
            {!isLast ? (
              <span
                aria-hidden
                className="absolute left-[15px] top-8 bottom-0 w-px bg-slate-200"
              />
            ) : null}
            <span
              className={cn(
                'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset',
                className,
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 pt-1">
              <p className="text-sm text-slate-800">{event.description}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {formatDateTime(event.createdAt)} · {actorLabel(event.actor)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
