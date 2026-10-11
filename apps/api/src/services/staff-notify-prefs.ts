/**
 * Pure selection logic for staff booking-notification preferences, extracted so
 * it is unit-testable without a database or email provider. Given the active
 * (non-guide) staff rows + their optional StaffNotificationPref and the set of
 * activity ids a booking touches, decide who gets emailed and who gets texted.
 *
 * Legacy default (no pref row): email on, SMS off, every activity — so existing
 * behaviour is unchanged until a member is opted down.
 */

export interface StaffNotifyPref {
  email_enabled: boolean;
  sms_enabled: boolean;
  sms_phone: string | null;
  /** Empty = every activity. Non-empty = only these Activity ids. */
  activity_ids: string[];
}

export interface StaffNotifyMember {
  email: string | null;
  notification_pref: StaffNotifyPref | null;
}

export interface StaffNotifyRecipients {
  emails: string[];
  phones: string[];
}

/** True if the member's activity filter overlaps the booking's activities. */
function activityMatches(prefActivityIds: string[], orderActivityIds: Set<string>): boolean {
  return (
    prefActivityIds.length === 0 || prefActivityIds.some((id) => orderActivityIds.has(id))
  );
}

/**
 * Split active staff into the email + SMS recipient lists for a new-booking
 * alert, honouring each member's channel toggles and activity filter.
 */
export function selectStaffNotifyRecipients(
  staff: StaffNotifyMember[],
  orderActivityIds: Iterable<string>,
): StaffNotifyRecipients {
  const activityIds = new Set(orderActivityIds);
  const emails: string[] = [];
  const phones: string[] = [];

  for (const member of staff) {
    const pref = member.notification_pref;
    // No pref row = legacy default: email on, SMS off, all activities.
    const wantsEmail = pref ? pref.email_enabled : true;
    const wantsSms = pref ? pref.sms_enabled : false;
    const scoped = pref ? activityMatches(pref.activity_ids, activityIds) : true;
    if (!scoped) continue;
    if (wantsEmail && member.email) emails.push(member.email);
    if (wantsSms && pref?.sms_phone) phones.push(pref.sms_phone);
  }

  return { emails, phones };
}
