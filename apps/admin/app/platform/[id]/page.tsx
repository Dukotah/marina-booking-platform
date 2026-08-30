import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { differenceInCalendarDays } from 'date-fns';
import { AlertTriangle, ArrowLeft, CalendarClock } from 'lucide-react';
import { getOperatorById, isPlatformAdmin } from '../../../lib/platform';
import { getOperatorContext } from '../../../lib/session';
import { loadReadiness } from '../../../lib/readiness';
import { formatDate, formatRelative, toDateInputValue } from '../../../lib/format';
import { EditClientForm } from '../_components/EditClientForm';
import { OpenClientButton } from '../_components/PlatformActions';
import { NOTE_HISTORY_LIMIT, getClientCockpit } from '../_components/cockpit-data';
import { NotesLog } from '../_components/NotesLog';
import { OnboardingDetailsForm } from '../_components/OnboardingDetailsForm';
import { ReadinessBoard } from '../_components/ReadinessBoard';
import { StageControl } from '../_components/StageControl';
import { VitalSigns } from '../_components/VitalSigns';
import { STAGE_LABEL, type OnboardingStageValue } from '../_components/onboarding-stages';
import type { ReadinessCheckView } from '../_components/readiness-contract';

export const metadata: Metadata = { title: 'Platform · Client' };
export const dynamic = 'force-dynamic';

/**
 * The onboarding cockpit for ONE client.
 *
 * This is the screen the owner works a new client from, so it is ordered the way he
 * asks the questions: what is on fire, where are they, what is left and whose move it
 * is, are they actually using it, and what did we last say to them. The account
 * settings form stays at the bottom — it is maintenance, not the day's work.
 *
 * Everything below the header is PLATFORM data (readiness, onboarding, notes). The
 * /platform layout redirects a non-platform identity before any of it renders; the
 * guard here is deliberate belt-and-braces, because this page reads across tenants.
 */
export default async function ClientCockpitPage({ params }: { params: { id: string } }) {
  const ctx = await getOperatorContext();
  if (!isPlatformAdmin(ctx.auth.userId)) notFound();

  const op = await getOperatorById(params.id);
  if (!op) notFound();

  const [cockpit, readinessByOperator] = await Promise.all([
    getClientCockpit(op.id),
    loadReadiness([
      {
        id: op.id,
        brandColor: op.brand_color,
        logoDarkUrl: op.logo_dark_url,
        logoLightUrl: op.logo_light_url,
      },
    ]),
  ]);

  const readiness = readinessByOperator.get(op.id) ?? null;
  const checks: ReadinessCheckView[] = (readiness?.checks ?? []).map((c) => ({
    id: c.id,
    label: c.label,
    status: c.status,
    detail: c.detail,
    court: c.court,
    href: c.fixHref || null,
  }));

  // No onboarding row yet? Show what the client's own data says rather than parking
  // everyone at PROVISIONED — and say plainly that nobody has set it, so a derived
  // guess is never mistaken for a decision somebody made.
  const stage: OnboardingStageValue = cockpit.onboarding.exists
    ? cockpit.onboarding.stage
    : ((readiness?.derivedStage as OnboardingStageValue | undefined) ?? 'PROVISIONED');

  const blocker = cockpit.notes.find((n) => n.isBlocker) ?? null;
  const target = cockpit.onboarding.targetLiveOn;
  const settled = stage === 'LIVE' || stage === 'CHURNED';
  const daysToTarget = target ? differenceInCalendarDays(target, new Date()) : null;
  const targetOverdue = daysToTarget !== null && daysToTarget < 0 && !settled;

  return (
    <div className="space-y-8">
      <Link
        href="/platform"
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> All clients
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold">{op.name_external}</h1>
            <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-slate-200">
              {STAGE_LABEL[stage]}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {op.slug}
            {readiness && (
              <>
                {' · '}
                {readiness.percent}% ready
                {readiness.blockedCount > 0 && ` · ${readiness.blockedCount} blocked`}
              </>
            )}
          </p>
        </div>
        <OpenClientButton operatorId={op.id} />
      </div>

      {/* What is on fire, before anything else on the page. */}
      {(blocker || targetOverdue) && (
        <div className="space-y-3">
          {blocker && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber-100">Blocked on</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-amber-50">
                  {blocker.body}
                </p>
                <p className="mt-1 text-xs text-amber-200/80">
                  Noted by {blocker.author} · {formatRelative(blocker.createdAt)}
                </p>
              </div>
            </div>
          )}
          {targetOverdue && target && daysToTarget !== null && (
            <div className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
              <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" aria-hidden />
              <div>
                <p className="text-sm font-semibold text-rose-100">Target go-live has passed</p>
                <p className="mt-0.5 text-sm text-rose-50">
                  {formatDate(target)} was {Math.abs(daysToTarget)}{' '}
                  {Math.abs(daysToTarget) === 1 ? 'day' : 'days'} ago and this client is still at{' '}
                  {STAGE_LABEL[stage].toLowerCase()}. Move the date or move the client.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <Section
        title="Where this client is"
        description="Stage, who owns it here, who to ring there, and the date we are working to."
      >
        <div className="space-y-6">
          <StageControl operatorId={op.id} stage={stage} />
          {!cockpit.onboarding.exists && (
            <p className="text-sm text-slate-400">
              Nobody has set a stage for this client yet — the one shown is what their data
              suggests. Picking one above files it properly.
            </p>
          )}
          {target && !targetOverdue && daysToTarget !== null && (
            <p className="text-sm text-slate-300">
              Target go-live {formatDate(target)}
              {settled
                ? '.'
                : daysToTarget === 0
                  ? ' — that is today.'
                  : ` — ${daysToTarget} ${daysToTarget === 1 ? 'day' : 'days'} away.`}
            </p>
          )}
          {cockpit.onboarding.wentLiveOn && (
            <p className="text-sm text-slate-400">
              Went live {formatDate(cockpit.onboarding.wentLiveOn)}.
            </p>
          )}
          <div className="border-t border-slate-800 pt-6">
            <OnboardingDetailsForm
              operatorId={op.id}
              values={{
                owner: cockpit.onboarding.owner,
                contactName: cockpit.onboarding.contactName,
                contactEmail: cockpit.onboarding.contactEmail,
                contactPhone: cockpit.onboarding.contactPhone,
                targetLiveOn: target ? toDateInputValue(target) : '',
              }}
            />
          </div>
          {(cockpit.onboarding.contactEmail || cockpit.onboarding.contactPhone) && (
            <p className="flex flex-wrap items-center gap-4 text-sm text-slate-400">
              {cockpit.onboarding.contactEmail && (
                <a
                  className="text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                  href={`mailto:${cockpit.onboarding.contactEmail}`}
                >
                  Email {cockpit.onboarding.contactName || 'the client'}
                </a>
              )}
              {cockpit.onboarding.contactPhone && (
                <a
                  className="text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                  href={`tel:${cockpit.onboarding.contactPhone.replace(/[^\d+]/g, '')}`}
                >
                  Call {cockpit.onboarding.contactPhone}
                </a>
              )}
            </p>
          )}
        </div>
      </Section>

      <Section
        title="What is left"
        description="Checked against their real data every time this page loads — never a stored copy."
      >
        <ReadinessBoard
          operatorId={op.id}
          clientName={op.name_external}
          checks={checks}
          engineAvailable={readiness !== null}
        />
      </Section>

      <Section
        title="Vital signs"
        description="Whether this client is actually running on the product."
      >
        <VitalSigns vitals={cockpit.vitals} isLive={stage === 'LIVE'} />
      </Section>

      <Section
        title="Notes"
        description="Calls, emails, and what we are waiting for. Newest first."
      >
        <NotesLog
          operatorId={op.id}
          notes={cockpit.notes}
          truncated={cockpit.notes.length >= NOTE_HISTORY_LIMIT}
        />
      </Section>

      <Section title="Account settings" description="Branding and plan for this client.">
        <EditClientForm
          values={{
            id: op.id,
            slug: op.slug,
            name_external: op.name_external,
            name_internal: op.name_internal,
            brand_color: op.brand_color,
            website: op.website ?? '',
            phone: op.phone ?? '',
            timezone: op.timezone,
            legal_adult_age: op.legal_adult_age,
            plan: op.plan,
            is_active: op.is_active,
          }}
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const id = `section-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="space-y-4">
      <div>
        <h2 id={id} className="text-lg font-semibold text-slate-100">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-slate-400">{description}</p>
      </div>
      {children}
    </section>
  );
}
