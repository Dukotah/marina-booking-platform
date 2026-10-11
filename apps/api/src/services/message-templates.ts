/**
 * Editable message templates (Singenuity §4).
 *
 * Operators may override the subject and/or body copy of the transactional emails
 * (booking confirmation, reminder, refund receipt). Overrides are stored in the
 * MessageTemplate table, one row per kind per operator. The notifications service
 * resolves the effective subject/body through `resolveTemplate`, which:
 *   - returns the built-in default when no (enabled) override exists, and
 *   - fills {{placeholders}} in an override with the supplied facts.
 *
 * Kept a thin, pure-ish helper so the placeholder substitution is unit-testable
 * without a DB or email provider. `resolveTemplate` never throws — a malformed or
 * missing override falls back to the default so a booking/refund flow is never
 * broken by a bad template.
 */
import type { MessageTemplateKind, TenantClient } from '@marina/database';

/** The resolved copy for one message: a subject line and an optional body. */
export interface ResolvedTemplate {
  subject: string;
  /** Body override (already interpolated) when the operator supplied one, else null. */
  body: string | null;
  /** True when an operator override supplied the subject (vs. the built-in default). */
  customized: boolean;
}

/** A stored override row (only the fields this resolver reads). */
export interface TemplateOverride {
  enabled: boolean;
  subject_override: string | null;
  body_override: string | null;
  /** SMS-channel body override (no subject on SMS). */
  sms_body_override: string | null;
}

/**
 * Substitute {{key}} tokens with values from `facts`. Unknown tokens are left as-is
 * (so a typo is visible rather than silently blanked). Whitespace inside the braces
 * is tolerated: `{{ order_number }}` works too.
 */
export function interpolate(template: string, facts: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const value = facts[key];
    return value === undefined ? match : value;
  });
}

/**
 * Resolve the effective subject/body for a message kind. `defaultSubject` is the
 * built-in copy; `override` is the operator's stored row (or null). Placeholders in
 * an enabled override are filled from `facts`. Falls back to the default on any
 * missing/blank override field.
 */
export function resolveTemplate(input: {
  defaultSubject: string;
  override: TemplateOverride | null;
  facts: Record<string, string>;
}): ResolvedTemplate {
  const { defaultSubject, override, facts } = input;
  if (!override || !override.enabled) {
    return { subject: defaultSubject, body: null, customized: false };
  }

  const rawSubject = override.subject_override?.trim();
  const subject = rawSubject ? interpolate(rawSubject, facts) : defaultSubject;

  const rawBody = override.body_override?.trim();
  const body = rawBody ? interpolate(rawBody, facts) : null;

  return { subject, body, customized: Boolean(rawSubject) };
}

/**
 * Resolve the effective SMS body for a message kind. SMS has no subject, so this is
 * a single string: an enabled operator override (with {{placeholders}} filled from
 * `facts`) when present and non-blank, else the built-in `defaultBody`. Never throws;
 * a missing/disabled/blank override cleanly falls back so an SMS flow is never broken
 * by a bad template.
 */
export function resolveSmsBody(input: {
  defaultBody: string;
  override: TemplateOverride | null;
  facts: Record<string, string>;
}): { body: string; customized: boolean } {
  const { defaultBody, override, facts } = input;
  if (!override || !override.enabled) {
    return { body: defaultBody, customized: false };
  }
  const raw = override.sms_body_override?.trim();
  if (!raw) return { body: defaultBody, customized: false };
  return { body: interpolate(raw, facts), customized: true };
}

/**
 * Load the operator's override for one message kind (or null). Tenant-scoped via the
 * RLS client. Returns null on any error so callers cleanly fall back to defaults.
 */
export async function loadTemplateOverride(
  db: TenantClient,
  kind: MessageTemplateKind,
): Promise<TemplateOverride | null> {
  try {
    const row = await db.messageTemplate.findFirst({
      where: { kind },
      select: { enabled: true, subject_override: true, body_override: true, sms_body_override: true },
    });
    return row ?? null;
  } catch (err) {
    console.error('[message-templates] loadTemplateOverride failed:', err);
    return null;
  }
}
