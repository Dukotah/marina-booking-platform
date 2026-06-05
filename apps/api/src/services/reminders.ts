/**
 * Reminder job service — sends pre-arrival reminder emails for upcoming bookings.
 *
 * There is no standing job runner (no Redis/BullMQ yet — ARCHITECTURE § 4: added
 * when needed). Instead this is an idempotent "send the reminders that are due
 * right now" sweep, designed to be triggered by an external scheduler (Vercel
 * Cron / Railway cron / any HTTP pinger) hitting POST /jobs/reminders on a regular
 * cadence. Each booking is reminded exactly once: the order carries a
 * `reminder_sent_at` stamp, and a reminded order is never re-selected.
 *
 * Tenant discipline: the sweep loops operators and does all per-tenant reads/writes
 * through the RLS-scoped `forOperator` client, so it never crosses tenants. Listing
 * the operators themselves is a genuine platform-admin read (adminPrisma), the one
 * audited cross-tenant path (ARCHITECTURE § 1).
 *
 * Delivery is best-effort: `sendReminder` never throws. We stamp `reminder_sent_at`
 * once a reminder has been *dispatched to the provider* (delivered OR provider
 * error), so a flaky provider tick can't make the job re-send the same booking on
 * every cron beat. A booking is left unstamped (and retried next run) only when
 * email is entirely unconfigured or the order wasn't actually eligible.
 */
import { adminPrisma, forOperator } from '@marina/database';
import { isEmailConfigured, sendReminder } from './notifications.js';

export interface SendDueRemindersOptions {
  /** Look-ahead window in hours: remind bookings starting within [now, now+lead]. Default 24. */
  leadHours?: number;
  /** Injectable clock for testing. Defaults to the current time. */
  now?: Date;
  /** Restrict the sweep to one operator (e.g. a tenant-triggered run). Default: all operators. */
  operatorId?: string;
  /** Safety cap on bookings reminded per operator per run. Default 500. */
  maxPerOperator?: number;
  /** Minutes before start to recommend check-in, forwarded to the email. Default 30. */
  checkInLeadMinutes?: number;
}

export interface ReminderRunSummary {
  emailConfigured: boolean;
  operators: number;
  /** Eligible bookings examined. */
  considered: number;
  /** Reminders actually delivered by the provider. */
  sent: number;
  /** Reminders dispatched but the provider/render reported a failure (still stamped). */
  failed: number;
  /** Eligible bookings skipped without dispatching (e.g. became ineligible mid-run). */
  skipped: number;
}

/** A skip reason from sendReminder that means "we reached the provider" → safe to stamp. */
function reachedProvider(skipReason: string | undefined): boolean {
  if (!skipReason) return false;
  return skipReason.startsWith('provider error') || skipReason === 'unexpected send failure';
}

/**
 * Find and send all reminders that are due, across one or all operators. Idempotent:
 * a booking with a `reminder_sent_at` is never re-selected. Returns a run summary.
 */
export async function sendDueReminders(
  options: SendDueRemindersOptions = {},
): Promise<ReminderRunSummary> {
  const summary: ReminderRunSummary = {
    emailConfigured: isEmailConfigured(),
    operators: 0,
    considered: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  // No Resend key → nothing can be delivered. Do zero DB work and leave every
  // booking unstamped so reminders flow the moment a key is configured.
  if (!summary.emailConfigured) return summary;

  const leadHours = options.leadHours ?? 24;
  const now = options.now ?? new Date();
  const windowEnd = new Date(now.getTime() + leadHours * 60 * 60 * 1000);
  const maxPerOperator = options.maxPerOperator ?? 500;
  const checkInLeadMinutes = options.checkInLeadMinutes;

  const operators = options.operatorId
    ? [{ id: options.operatorId }]
    : await adminPrisma.operator.findMany({ select: { id: true } });
  summary.operators = operators.length;

  for (const op of operators) {
    const db = forOperator(op.id);

    // Eligible: upcoming, not yet reminded, has a real (non-synthetic) email, and a
    // booked timeslot inside the look-ahead window.
    const due = await db.order.findMany({
      where: {
        status: 'UPCOMING',
        reminder_sent_at: null,
        // Customer.email is required, so every order has one; exclude only the
        // synthetic addresses we mint for anonymous POS walk-ins (they don't deliver).
        NOT: { customer: { email: { endsWith: '@pos.local' } } },
        items: { some: { timeslot: { datetime: { gte: now, lte: windowEnd } } } },
      },
      select: { id: true },
      orderBy: { created_at: 'asc' },
      take: maxPerOperator,
    });

    for (const order of due) {
      summary.considered++;
      const result = await sendReminder({
        operatorId: op.id,
        orderId: order.id,
        ...(checkInLeadMinutes != null ? { checkInLeadMinutes } : {}),
      });

      if (result.sent) {
        summary.sent++;
      } else if (reachedProvider(result.skippedReason)) {
        summary.failed++;
      } else {
        // Became ineligible between select and send (status change / no recipient).
        // Leave it unstamped — it simply won't qualify next run either.
        summary.skipped++;
        continue;
      }

      // Stamp once dispatched so the next sweep never re-sends this booking.
      await db.order.update({ where: { id: order.id }, data: { reminder_sent_at: now } });
    }
  }

  return summary;
}
