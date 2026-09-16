/**
 * Rolling-horizon schedule materialization sweep.
 *
 * ScheduleRules materialize timeslots RULE_HORIZON_DAYS ahead. Saving a rule (or a
 * blackout) materializes its activity immediately; this sweep is the second half of
 * the pattern — run daily (cron → POST /internal/schedules/run) it tops the horizon
 * back up as days roll forward, across every active operator.
 *
 * Cross-tenant enumeration uses adminPrisma (this is a genuine platform-level
 * sweep, same posture as runAllDueReminders); every WRITE goes through
 * withTenant so RLS scopes it to the operator being processed.
 */
import { adminPrisma, withTenant, materializeActivitySchedule } from '@marina/database';
import { captureError } from './errors.js';

export interface ScheduleSweepActivityResult {
  operatorId: string;
  activityId: string;
  created: number;
  resized: number;
  removed: number;
  closed: number;
}

export interface ScheduleSweepResult {
  operators: number;
  activities: number;
  created: number;
  removed: number;
  perActivity: ScheduleSweepActivityResult[];
}

/** Materialize every activity that has at least one active rule, per operator. */
export async function runScheduleSweep(opts?: { horizonDays?: number }): Promise<ScheduleSweepResult> {
  const targets = await adminPrisma.scheduleRule.groupBy({
    by: ['operator_id', 'activity_id'],
    where: { is_active: true, activity: { operator: { is_active: true } } },
  });

  const perActivity: ScheduleSweepActivityResult[] = [];
  const operators = new Set<string>();

  for (const target of targets) {
    operators.add(target.operator_id);
    // Isolate failures: one activity's bad schedule must not stop the rest.
    try {
      const result = await withTenant(target.operator_id, (tx) =>
        materializeActivitySchedule(tx, {
          operatorId: target.operator_id,
          activityId: target.activity_id,
          horizonDays: opts?.horizonDays,
        }),
      );
      perActivity.push({
        operatorId: target.operator_id,
        activityId: target.activity_id,
        created: result.created,
        resized: result.resized,
        removed: result.removed,
        closed: result.closed,
      });
    } catch (err) {
      await captureError(err, {
        operatorId: target.operator_id,
        route: 'schedules.runScheduleSweep',
      });
      perActivity.push({
        operatorId: target.operator_id,
        activityId: target.activity_id,
        created: 0,
        resized: 0,
        removed: 0,
        closed: 0,
      });
    }
  }

  return {
    operators: operators.size,
    activities: targets.length,
    created: perActivity.reduce((n, r) => n + r.created, 0),
    removed: perActivity.reduce((n, r) => n + r.removed, 0),
    perActivity,
  };
}
