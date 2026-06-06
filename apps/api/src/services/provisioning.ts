/**
 * Operator provisioning — the self-serve front door (Phase 2, D-032).
 *
 * This is the ONE write that runs BEFORE a tenant scope exists, so — like the seed
 * — it uses `adminPrisma` (the owner connection), not a tenant-scoped client. It
 * creates a complete, usable tenant in a single transaction: Operator + a default
 * Location + a starter liability Waiver + checkout config + the first OWNER
 * StaffMember bound to the signup identity. Activities/rates/availability come next
 * via the guided onboarding wizard.
 *
 * Isolation note: provisioning only ever CREATES a brand-new operator and rows
 * stamped with that new operator_id. It never reads or writes another tenant's data.
 * RLS policies are table-wide, so the new tenant is covered with no per-tenant DDL.
 */
import { adminPrisma } from '@marina/database';
import { createId } from '@marina/core';

/** Slugs we never hand to a tenant (reserved for the platform / routing). */
const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'dashboard', 'signup', 'sign-up', 'signin', 'sign-in',
  'login', 'logout', 'register', 'account', 'billing', 'support', 'help', 'status',
  'mail', 'email', 'ftp', 'blog', 'docs', 'static', 'assets', 'cdn', 'public', 'internal',
  'webhooks', 'jobs', 'health', 'marina', 'operator', 'operators',
]);

const SLUG_MIN = 3;
const SLUG_MAX = 40;

export class ProvisioningError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ProvisioningError';
    this.code = code;
    this.status = status;
  }
}

/** Normalize arbitrary text into a slug candidate (lowercase, hyphenated, trimmed). */
export function normalizeSlug(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SLUG_MAX);
}

/** Structural validity (format + length + reserved). Does NOT check uniqueness. */
export function slugFormatError(slug: string): string | null {
  if (slug.length < SLUG_MIN) return `Must be at least ${SLUG_MIN} characters.`;
  if (slug.length > SLUG_MAX) return `Must be at most ${SLUG_MAX} characters.`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return 'Use lowercase letters, numbers, and single hyphens only.';
  }
  if (RESERVED_SLUGS.has(slug)) return 'That name is reserved — please choose another.';
  return null;
}

/** True if no active-or-inactive operator already owns this slug. */
async function slugIsFree(slug: string): Promise<boolean> {
  const existing = await adminPrisma.operator.findUnique({ where: { slug }, select: { id: true } });
  return existing === null;
}

/** Public availability check used by the signup form (format + uniqueness + a suggestion). */
export async function checkSlugAvailability(
  raw: string,
): Promise<{ slug: string; available: boolean; reason?: string; suggestion?: string }> {
  const slug = normalizeSlug(raw);
  const formatErr = slugFormatError(slug);
  if (formatErr) return { slug, available: false, reason: formatErr };
  if (await slugIsFree(slug)) return { slug, available: true };
  return { slug, available: false, reason: 'Already taken.', suggestion: await suggestFreeSlug(slug) };
}

/** Append -2, -3, … until a free slug is found (bounded). */
async function suggestFreeSlug(base: string): Promise<string> {
  for (let n = 2; n <= 50; n++) {
    const candidate = `${base.slice(0, SLUG_MAX - 3)}-${n}`;
    if (await slugIsFree(candidate)) return candidate;
  }
  // Fall back to a short random suffix that's effectively always free.
  return `${base.slice(0, SLUG_MAX - 5)}-${createId().slice(0, 4)}`;
}

/** Derive an uppercase alphanumeric location code (used as the order-number prefix). */
function deriveLocationCodeBase(businessName: string, slug: string): string {
  const words = businessName.trim().split(/\s+/).filter(Boolean);
  let base = '';
  if (words.length >= 2) {
    base = words.map((w) => w[0]).join('').replace(/[^a-zA-Z0-9]/g, '');
  }
  if (base.length < 3) {
    base = slug.replace(/[^a-z0-9]/g, '');
  }
  base = base.toUpperCase().slice(0, 4);
  return base.length >= 2 ? base : 'OPR';
}

/** Ensure the location_code is unique (it has a unique constraint), suffixing digits if needed. */
async function uniqueLocationCode(base: string): Promise<string> {
  const candidates = [base];
  for (let n = 2; n <= 99; n++) candidates.push(`${base.slice(0, 3)}${n}`);
  for (const code of candidates) {
    const taken = await adminPrisma.operator.findUnique({
      where: { location_code: code },
      select: { id: true },
    });
    if (!taken) return code;
  }
  return `${base.slice(0, 2)}${createId().slice(0, 4).toUpperCase()}`;
}

export interface ProvisionInput {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  /** Optional desired slug; derived from businessName when omitted. */
  slug?: string;
  /**
   * The owner's auth_user_id. In production this is the verified Clerk user id; in
   * dev it may be omitted and a deterministic dev id is generated so the operator is
   * still reachable for testing.
   */
  authUserId?: string;
}

export interface ProvisionResult {
  operatorId: string;
  slug: string;
  locationCode: string;
  /** The OWNER staff auth_user_id (Clerk id in prod, generated dev id otherwise). */
  ownerAuthUserId: string;
}

const STARTER_WAIVER_HTML =
  '<h1>Liability Waiver &amp; Agreement</h1>' +
  '<p>I acknowledge the inherent risks of the activity, confirm I am physically able to ' +
  'participate, and agree to follow all safety instructions and rental terms, including the ' +
  'cancellation policy and responsibility for damage. I release the operator from liability ' +
  'for injury or loss to the extent permitted by law.</p>';

/**
 * Provision a brand-new operator (tenant). Validates + reserves a unique slug and
 * location_code, then creates the operator and its starter rows in one transaction.
 */
export async function provisionOperator(input: ProvisionInput): Promise<ProvisionResult> {
  const businessName = input.businessName?.trim();
  const ownerName = input.ownerName?.trim();
  const ownerEmail = input.ownerEmail?.trim().toLowerCase();

  if (!businessName || businessName.length < 2) {
    throw new ProvisioningError('INVALID_NAME', 'A business name is required.');
  }
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new ProvisioningError('INVALID_EMAIL', 'A valid owner email is required.');
  }

  const slug = normalizeSlug(input.slug?.trim() || businessName);
  const formatErr = slugFormatError(slug);
  if (formatErr) throw new ProvisioningError('INVALID_SLUG', formatErr);
  if (!(await slugIsFree(slug))) {
    throw new ProvisioningError('SLUG_TAKEN', 'That address is already taken.', 409);
  }

  const locationCode = await uniqueLocationCode(deriveLocationCodeBase(businessName, slug));
  const ownerAuthUserId = input.authUserId?.trim() || `owner-${createId()}`;
  const operatorId = createId();

  await adminPrisma.$transaction(async (tx) => {
    await tx.operator.create({
      data: {
        id: operatorId,
        slug,
        location_code: locationCode,
        name_internal: businessName,
        name_external: businessName,
        plan: 'trial',
        is_active: true,
      },
    });

    const location = await tx.location.create({
      data: {
        operator_id: operatorId,
        name: businessName,
        is_default: true,
        is_active: true,
      },
    });

    await tx.waiver.create({
      data: {
        operator_id: operatorId,
        name: 'Liability Waiver & Agreement',
        requires_minor_signature: true,
        template_html: STARTER_WAIVER_HTML,
      },
    });

    // Checkout config (tip presets / check-in window) — the config-record pattern.
    await tx.integration.create({
      data: {
        operator_id: operatorId,
        key: 'checkout',
        enabled: true,
        config: { tip_presets: [15, 20, 25], default_tip: 20, checkin_minutes: 30 },
      },
    });

    await tx.staffMember.create({
      data: {
        operator_id: operatorId,
        auth_user_id: ownerAuthUserId,
        name: ownerName || businessName,
        email: ownerEmail,
        role: 'OWNER',
        is_active: true,
        locations: { create: { location_id: location.id } },
      },
    });
  });

  return { operatorId, slug, locationCode, ownerAuthUserId };
}
