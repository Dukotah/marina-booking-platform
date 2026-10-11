'use client';

import { Fragment, useState, useTransition } from 'react';
import { Bell, ChevronDown, Mail, MessageSquare } from 'lucide-react';
import { cn } from '../../lib/cn';
import { saveNotificationPref } from '../../app/staff/actions';

export interface ActivityOption {
  id: string;
  name: string;
}

/** Per-staff notification preference row (serializable; no Date objects). */
export interface NotificationPrefRow {
  staffId: string;
  name: string;
  email: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
  smsPhone: string | null;
  /** Empty = every activity. */
  activityIds: string[];
}

export interface NotificationPrefsProps {
  rows: NotificationPrefRow[];
  activities: ActivityOption[];
  canManage: boolean;
}

/** Short summary of a member's current prefs for the collapsed row. */
function summarize(row: NotificationPrefRow, activities: ActivityOption[]): string {
  const channels: string[] = [];
  if (row.emailEnabled) channels.push('Email');
  if (row.smsEnabled) channels.push('SMS');
  const channelLabel = channels.length ? channels.join(' + ') : 'Off';
  const scope =
    row.activityIds.length === 0
      ? 'all activities'
      : `${row.activityIds.length} of ${activities.length} activities`;
  return `${channelLabel} · ${scope}`;
}

/**
 * Booking-notification preferences, one row per active non-guide staff member.
 * Each row expands to channel toggles (email / SMS with a phone) and an activity
 * filter so new-booking alerts can be narrowed per person instead of all-or-nothing.
 * Clean-SaaS teal tokens, 44px touch targets. Read-only without staff:manage.
 */
export function NotificationPrefs({ rows, activities, canManage }: NotificationPrefsProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm">
        No staff members to notify yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full border-collapse text-sm">
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const expanded = expandedId === row.staffId;
            return (
              <Fragment key={row.staffId}>
                <tr
                  className={cn(
                    'transition-colors',
                    canManage && 'cursor-pointer hover:bg-slate-50',
                    expanded && 'bg-slate-50',
                  )}
                  onClick={
                    canManage ? () => setExpandedId(expanded ? null : row.staffId) : undefined
                  }
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{row.name || row.email}</div>
                    <div className="flex items-center gap-1 text-xs text-slate-500">
                      <Bell className="h-3 w-3" aria-hidden />
                      {summarize(row, activities)}
                    </div>
                  </td>
                  {canManage ? (
                    <td className="px-4 py-3 text-right">
                      <ChevronDown
                        className={cn(
                          'inline h-4 w-4 text-slate-400 transition-transform',
                          expanded && 'rotate-180',
                        )}
                        aria-hidden
                      />
                    </td>
                  ) : null}
                </tr>
                {canManage && expanded ? (
                  <tr className="bg-slate-50">
                    <td colSpan={2} className="px-4 pb-5 pt-1">
                      <PrefEditor
                        row={row}
                        activities={activities}
                        onDone={() => setExpandedId(null)}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PrefEditor({
  row,
  activities,
  onDone,
}: {
  row: NotificationPrefRow;
  activities: ActivityOption[];
  onDone: () => void;
}) {
  const [emailEnabled, setEmailEnabled] = useState(row.emailEnabled);
  const [smsEnabled, setSmsEnabled] = useState(row.smsEnabled);
  const [smsPhone, setSmsPhone] = useState(row.smsPhone ?? '');
  const [allActivities, setAllActivities] = useState(row.activityIds.length === 0);
  const [activityIds, setActivityIds] = useState<string[]>(row.activityIds);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleActivity = (id: string) => {
    setActivityIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const onSave = () => {
    setMessage(null);
    setFieldError(null);
    startTransition(async () => {
      const result = await saveNotificationPref({
        staffId: row.staffId,
        emailEnabled,
        smsEnabled,
        smsPhone: smsPhone.trim() || undefined,
        activityIds: allActivities ? [] : activityIds,
      });
      if (result.ok) {
        onDone();
      } else if (result.errors?.smsPhone) {
        setFieldError(result.errors.smsPhone);
      } else {
        setMessage(result.message ?? 'Could not save preferences.');
      }
    });
  };

  return (
    <div className="space-y-5 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Channels
        </legend>
        <label className="flex min-h-[44px] items-center gap-3">
          <input
            type="checkbox"
            checked={emailEnabled}
            onChange={(e) => setEmailEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent"
          />
          <Mail className="h-4 w-4 text-slate-400" aria-hidden />
          <span className="text-sm text-slate-700">Email on new bookings</span>
        </label>
        <label className="flex min-h-[44px] items-center gap-3">
          <input
            type="checkbox"
            checked={smsEnabled}
            onChange={(e) => setSmsEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent"
          />
          <MessageSquare className="h-4 w-4 text-slate-400" aria-hidden />
          <span className="text-sm text-slate-700">Text (SMS) on new bookings</span>
        </label>
        {smsEnabled ? (
          <div className="pl-7">
            <input
              type="tel"
              inputMode="tel"
              value={smsPhone}
              onChange={(e) => setSmsPhone(e.target.value)}
              placeholder="Mobile number, e.g. (707) 555-0199"
              className="min-h-[44px] w-full max-w-xs rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-accent focus:ring-accent"
            />
            {fieldError ? (
              <p className="mt-1 text-xs text-rose-600">{fieldError}</p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Activities
        </legend>
        <label className="flex min-h-[44px] items-center gap-3">
          <input
            type="checkbox"
            checked={allActivities}
            onChange={(e) => setAllActivities(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent"
          />
          <span className="text-sm text-slate-700">All activities</span>
        </label>
        {!allActivities ? (
          <div className="grid gap-2 pl-7 sm:grid-cols-2">
            {activities.length === 0 ? (
              <p className="text-xs text-slate-500">No activities configured.</p>
            ) : (
              activities.map((a) => (
                <label key={a.id} className="flex min-h-[44px] items-center gap-3">
                  <input
                    type="checkbox"
                    checked={activityIds.includes(a.id)}
                    onChange={() => toggleActivity(a.id)}
                    className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent"
                  />
                  <span className="text-sm text-slate-700">{a.name}</span>
                </label>
              ))
            )}
          </div>
        ) : null}
      </fieldset>

      {message ? <p className="text-sm text-rose-600">{message}</p> : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="inline-flex min-h-[44px] items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save preferences'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={pending}
          className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
