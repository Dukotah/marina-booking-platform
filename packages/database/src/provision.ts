/**
 * Operator provisioning — the platform-level "create a new client" engine.
 *
 * Creating an operator is a PLATFORM operation (there is no tenant yet), so it
 * runs through `adminPrisma` (the owner/platform connection, which is the only
 * connection allowed to write across tenants — see D-010). We still set the
 * tenant GUC for the child inserts so the same code works even through a
 * non-bypass connection.
 *
 * This is what the super-admin "New client" form and the `new-client` CLI both
 * call. It creates the operator, a default location, baseline fees, a default
 * waiver + checkout config, and the owner staff member (whose `auth_user_id` is
 * the Clerk id in prod, or a dev id for the local shim).
 */

import { adminPrisma } from './client.js';

export interface NewOperatorInput {
  /** Subdomain-safe unique slug, e.g. "russian-river-kayak". */
  slug: string;
  /** Customer-facing brand name, e.g. "Russian River Kayak Co." */
  nameExternal: string;
  /** Internal/legal name. Defaults to nameExternal. */
  nameInternal?: string;
  /** Legacy unique short code (e.g. "RRKC"). Derived from slug when omitted. */
  locationCode?: string;
  /** Hex brand color. Default #0ea5e9. */
  brandColor?: string;
  /** IANA timezone. Default America/Los_Angeles. */
  timezone?: string;
  /** Minimum age to be the responsible party. Default 18. */
  legalAdultAge?: number;
  website?: string;
  phone?: string;
  /** Subscription plan label. Default "trial". */
  plan?: string;
  /** First location. Name defaults to nameExternal. */
  location?: { name?: string; city?: string; state?: string };
  /** Owner staff member. authUserId = Clerk id (prod) or dev shim id (local). */
  owner: { name: string; email: string; authUserId: string };
  /** Sales tax percent (e.g. 9.25). Default 0 (none). */
  salesTaxPercent?: number;
  /** Card processing fee percent (e.g. 4.0). Default 0 (none). */
  processingFeePercent?: number;
  /** Default liability waiver. Pass null to skip creating one. */
  waiver?: {
    name?: string;
    templateHtml?: string;
    requiresMinorSignature?: boolean;
  } | null;
}

export interface NewOperatorResult {
  operatorId: string;
  slug: string;
  locationId: string;
  ownerStaffId: string;
}

/** Raised for invalid input or a uniqueness conflict, with a clean message. */
export class ProvisionError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PROVISION_ERROR') {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
  }
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function deriveLocationCode(slug: string): string {
  const code = slug.replace(/[^a-z0-9]/g, '').slice(0, 8).toUpperCase();
  return code || 'OP';
}

/**
 * Create a fully usable operator (client) and return its ids. Throws
 * ProvisionError on bad input or a duplicate slug/location_code/owner email.
 */
export async function createOperator(
  input: NewOperatorInput,
): Promise<NewOperatorResult> {
  const slug = input.slug?.trim().toLowerCase() ?? '';
  if (!SLUG_RE.test(slug)) {
    throw new ProvisionError(
      'Slug must be lowercase letters, numbers, and single hyphens (e.g. "russian-river-kayak").',
      'INVALID_SLUG',
    );
  }
  const nameExternal = input.nameExternal?.trim();
  if (!nameExternal) {
    throw new ProvisionError('A business name is required.', 'INVALID_NAME');
  }
  const ownerName = input.owner?.name?.trim();
  const ownerEmail = input.owner?.email?.trim().toLowerCase();
  const ownerAuthId = input.owner?.authUserId?.trim();
  if (!ownerName || !ownerEmail || !ownerAuthId) {
    throw new ProvisionError(
      'Owner name, email, and auth id are all required.',
      'INVALID_OWNER',
    );
  }
  const brandColor = input.brandColor?.trim() || '#0ea5e9';
  if (!HEX_RE.test(brandColor)) {
    throw new ProvisionError('Brand color must be a hex value like #0e7490.', 'INVALID_COLOR');
  }

  try {
    return await adminPrisma.$transaction(async (tx) => {
      const operator = await tx.operator.create({
        data: {
          slug,
          name_external: nameExternal,
          name_internal: input.nameInternal?.trim() || nameExternal,
          location_code: (input.locationCode?.trim() || deriveLocationCode(slug)).toUpperCase(),
          website: input.website?.trim() || null,
          phone: input.phone?.trim() || null,
          timezone: input.timezone?.trim() || 'America/Los_Angeles',
          legal_adult_age: input.legalAdultAge ?? 18,
          brand_color: brandColor,
          plan: input.plan?.trim() || 'trial',
        },
      });

      // Scope the rest of the tx to the new tenant so RLS WITH CHECK passes even
      // through a non-bypass connection.
      await tx.$executeRawUnsafe(
        `SET LOCAL app.current_operator_id = '${operator.id}'`,
      );

      const location = await tx.location.create({
        data: {
          operator_id: operator.id,
          name: input.location?.name?.trim() || nameExternal,
          city: input.location?.city?.trim() || null,
          state: input.location?.state?.trim() || null,
          is_default: true,
        },
      });

      const fees: { operator_id: string; name: string; type: 'PERCENT'; value: number }[] = [];
      if (input.salesTaxPercent && input.salesTaxPercent > 0) {
        fees.push({ operator_id: operator.id, name: 'Sales Tax', type: 'PERCENT', value: input.salesTaxPercent });
      }
      if (input.processingFeePercent && input.processingFeePercent > 0) {
        fees.push({ operator_id: operator.id, name: 'Processing Fee', type: 'PERCENT', value: input.processingFeePercent });
      }
      if (fees.length) await tx.fee.createMany({ data: fees });

      if (input.waiver !== null) {
        await tx.waiver.create({
          data: {
            operator_id: operator.id,
            name: input.waiver?.name?.trim() || 'Liability Waiver',
            requires_minor_signature: input.waiver?.requiresMinorSignature ?? true,
            template_html:
              input.waiver?.templateHtml?.trim() ||
              `<h1>Liability Waiver</h1><p>I acknowledge the risks of this activity and agree to ${nameExternal}'s rental terms, cancellation policy, and damage responsibilities.</p>`,
          },
        });
      }

      await tx.integration.create({
        data: {
          operator_id: operator.id,
          key: 'checkout',
          enabled: true,
          config: { tip_presets: [15, 20, 25], default_tip: 20, checkin_minutes: 30 },
        },
      });

      const owner = await tx.staffMember.create({
        data: {
          operator_id: operator.id,
          auth_user_id: ownerAuthId,
          name: ownerName,
          email: ownerEmail,
          role: 'OWNER',
          is_active: true,
          locations: { create: { location_id: location.id } },
        },
      });

      return {
        operatorId: operator.id,
        slug: operator.slug,
        locationId: location.id,
        ownerStaffId: owner.id,
      };
    });
  } catch (err) {
    // Prisma unique-constraint violation → friendly message.
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002') {
      const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? '');
      const field = target.includes('slug')
        ? 'slug'
        : target.includes('location_code')
          ? 'location code'
          : target.includes('auth_user_id')
            ? 'owner login'
            : 'value';
      throw new ProvisionError(`That ${field} is already taken. Choose another.`, 'DUPLICATE');
    }
    throw err;
  }
}
