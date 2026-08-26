/**
 * Display taxonomy for audit actions.
 *
 * Classification is by the dotted prefix the API writes (`payment.refund`,
 * `customer.update`), never by an enumerated list of action names. The admin app
 * and the API are separate packages, so a shared list would drift the moment a
 * new action ships — a prefix rule keeps an unknown action readable and
 * correctly filed instead of falling off the page.
 */

export type AuditCategory = 'money' | 'personal' | 'access' | 'config' | 'other';

export interface CategoryMeta {
  label: string;
  /** Badge classes, matching the admin's slate/sky/amber status palette. */
  badgeClass: string;
}

export const CATEGORY_META: Record<AuditCategory, CategoryMeta> = {
  money: { label: 'Money', badgeClass: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  personal: { label: 'Personal data', badgeClass: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
  access: { label: 'Access', badgeClass: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  config: { label: 'Settings', badgeClass: 'bg-violet-50 text-violet-700 ring-violet-600/20' },
  other: { label: 'Other', badgeClass: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
};

/**
 * The action subjects that belong to each category. This is the single source
 * for both the badge on a row and the `startsWith` filter the server query
 * builds, so the tab and the label can never disagree about what "Money" means.
 */
export const CATEGORY_SUBJECTS: Record<Exclude<AuditCategory, 'other'>, readonly string[]> = {
  money: ['payment', 'payout', 'refund', 'gift_card', 'order'],
  personal: ['customer', 'waiver'],
  access: ['staff', 'role'],
  config: ['settings', 'operator', 'integration'],
};

/** The subject half of a dotted action: `payment.refund` -> `payment`. */
function subjectOf(action: string): string {
  const dot = action.indexOf('.');
  return dot === -1 ? action : action.slice(0, dot);
}

export function categoryOf(action: string): AuditCategory {
  const subject = subjectOf(action);
  for (const [category, subjects] of Object.entries(CATEGORY_SUBJECTS)) {
    if (subjects.includes(subject)) return category as AuditCategory;
  }
  return 'other';
}

export function isAuditCategory(value: string): value is Exclude<AuditCategory, 'other'> {
  return value in CATEGORY_SUBJECTS;
}

/** `staff.role_change` -> `Staff role change`. */
export function actionLabel(action: string): string {
  const words = action.replace(/[._]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `first_name` -> `First name`. Field labels in the diff table. */
export function fieldLabel(field: string): string {
  const stripped = field.replace(/_cents$/, '').replace(/^_/, '');
  const words = stripped.replace(/[._]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True when a field holds integer cents and should render as currency. */
export function isMoneyField(field: string): boolean {
  return field.endsWith('_cents');
}
