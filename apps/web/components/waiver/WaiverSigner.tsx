'use client';

/**
 * Clause-level liability-waiver signing UI (California boat rental).
 *
 * Fetches the operator's active waiver + ordered clauses, renders each clause with
 * its own initials field, collects the signer's full legal name, date of birth,
 * and (for minors) a guardian name, and blocks submission until every REQUIRED
 * clause is initialed. On submit it POSTs the acknowledgments + signature to
 * /api/waivers/sign, which builds the immutable legal snapshot server-side.
 *
 * White-label: no platform branding; the waiver copy comes from the operator's
 * own clause text.
 *
 * Accessibility matters more here than anywhere else in the flow, because this
 * screen collects a legal signature: every initials box names the clause it
 * belongs to, required-and-unmet clauses are announced as such, a blocked submit
 * moves focus to a summary that links to each missing item, and the success
 * state takes focus so the signer is told the signature was recorded rather than
 * being left on a form that silently vanished.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { Button, Input, Label } from '@marina/ui';
import {
  getActiveWaiver,
  signWaiver,
  ApiError,
  type ActiveWaiver,
  type WaiverClause,
} from '@/lib/api';

interface WaiverSignerProps {
  /** The order item this signature applies to. */
  orderItemId: string;
  /** Optional activity id to scope the waiver (future per-activity mapping). */
  activityId?: string;
  /** Called after a successful signature. */
  onSigned?: () => void;
}

/** One unmet requirement, in page order, linkable from the error summary. */
interface WaiverProblem {
  key: string;
  label: string;
  message: string;
  fieldId: string;
}

/** Is the signer a minor, given a YYYY-MM-DD date of birth? (18 in California.) */
function isMinorDob(dob: string): boolean {
  if (!dob) return false;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return false;
  const eighteen = new Date(d.getFullYear() + 18, d.getMonth(), d.getDate());
  return eighteen.getTime() > Date.now();
}

export function WaiverSigner({ orderItemId, activityId, onSigned }: WaiverSignerProps) {
  const [waiver, setWaiver] = useState<ActiveWaiver | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [initials, setInitials] = useState<Record<string, string>>({});
  const [signerName, setSignerName] = useState('');
  const [dob, setDob] = useState('');
  const [guardianName, setGuardianName] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);
  const [touched, setTouched] = useState(false);
  // Bumped on every blocked submit so focus returns to the summary even when the
  // same requirements are still outstanding.
  const [blockedCount, setBlockedCount] = useState(0);

  const summaryRef = useRef<HTMLDivElement>(null);
  const signedRef = useRef<HTMLDivElement>(null);

  const summaryHeadingId = useId();
  const signatureHintId = useId();
  const dobHintId = useId();
  const guardianHintId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getActiveWaiver(activityId)
      .then((w) => {
        if (!cancelled) setWaiver(w);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? 'No waiver is configured for this activity.'
              : 'We could not load the waiver. Please try again.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  const minor = isMinorDob(dob);

  const missingRequired = useMemo(() => {
    if (!waiver) return [] as WaiverClause[];
    return waiver.clauses.filter(
      (c) => c.isRequired && c.requiresInitials && !(initials[c.id] ?? '').trim(),
    );
  }, [waiver, initials]);

  const canSubmit =
    !!waiver &&
    signerName.trim().length > 0 &&
    missingRequired.length === 0 &&
    (!minor || guardianName.trim().length > 0);

  // Listed in the order they appear on the page so the summary reads as a
  // top-to-bottom to-do list rather than an arbitrary set.
  const problems = useMemo<WaiverProblem[]>(() => {
    const list: WaiverProblem[] = [];
    for (const clause of missingRequired) {
      const index = waiver ? waiver.clauses.indexOf(clause) : -1;
      list.push({
        key: `clause-${clause.id}`,
        label: index >= 0 ? `Section ${index + 1}: ${clause.title}` : clause.title,
        message: 'Your initials are required.',
        fieldId: `initials-${clause.id}`,
      });
    }
    if (!signerName.trim()) {
      list.push({
        key: 'signerName',
        label: 'Signature',
        message: 'Type your full legal name to sign.',
        fieldId: 'signerName',
      });
    }
    if (minor && !guardianName.trim()) {
      list.push({
        key: 'guardianName',
        label: 'Parent / guardian name',
        message: 'Required because the date of birth given is under 18.',
        fieldId: 'guardianName',
      });
    }
    return list;
  }, [missingRequired, waiver, signerName, minor, guardianName]);

  const showSummary = touched && problems.length > 0;

  // A blocked submit is otherwise completely silent: the button does nothing and
  // a screen-reader user is given no reason why.
  useEffect(() => {
    if (blockedCount > 0) summaryRef.current?.focus();
  }, [blockedCount]);

  // The form is replaced by the confirmation panel, which would drop focus to
  // the document body and strand the signer at the top of the page.
  useEffect(() => {
    if (signed) signedRef.current?.focus();
  }, [signed]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setSubmitError(null);
    if (!waiver || !canSubmit) {
      setBlockedCount((n) => n + 1);
      return;
    }

    setSubmitting(true);
    try {
      const acknowledgments = waiver.clauses
        .map((c) => ({ clauseId: c.id, initials: (initials[c.id] ?? '').trim() }))
        // Send every initialed clause (required + any optional the signer accepted).
        .filter((a) => a.initials.length > 0);

      await signWaiver({
        orderItemId,
        signerName: signerName.trim(),
        signerDob: dob || undefined,
        // Typed signature — the signer's full legal name captured as the signature.
        signatureData: `typed:${signerName.trim()}`,
        isMinor: minor,
        guardianName: minor ? guardianName.trim() : undefined,
        acknowledgments,
      });
      setSigned(true);
      onSigned?.();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <p role="status" className="text-sm text-slate-500">
        Loading waiver…
      </p>
    );
  }
  if (loadError) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{loadError}</span>
      </div>
    );
  }
  if (!waiver) return null;

  if (signed) {
    return (
      <div
        ref={signedRef}
        tabIndex={-1}
        role="status"
        className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"
      >
        <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden />
        <span>Thank you — your waiver has been signed and recorded.</span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5" aria-busy={submitting}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <ShieldCheck className="h-5 w-5 text-[var(--brand-color,#0f766e)]" aria-hidden />
        {waiver.name}
      </h2>

      {waiver.introHtml ? (
        <div
          className="prose prose-sm max-w-none text-slate-600"
          // Operator-authored copy.
          dangerouslySetInnerHTML={{ __html: waiver.introHtml }}
        />
      ) : null}

      {showSummary ? (
        <div
          ref={summaryRef}
          tabIndex={-1}
          aria-labelledby={summaryHeadingId}
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
        >
          <h3
            id={summaryHeadingId}
            className="flex items-center gap-2 text-sm font-semibold text-amber-900"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {problems.length === 1
              ? 'One thing is still needed before you can sign'
              : `${problems.length} things are still needed before you can sign`}
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {problems.map((problem) => (
              <li key={problem.key}>
                <a href={`#${problem.fieldId}`} className="rounded underline">
                  {problem.label}: {problem.message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ol className="space-y-4">
        {waiver.clauses.map((c, idx) => {
          const value = initials[c.id] ?? '';
          const showError = touched && c.isRequired && c.requiresInitials && !value.trim();
          const headingId = `clause-title-${c.id}`;
          const labelId = `initials-label-${c.id}`;
          const errorId = `initials-error-${c.id}`;
          return (
            <li
              key={c.id}
              className="rounded-lg border border-slate-200 bg-white p-4"
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <h3 id={headingId} className="text-sm font-semibold text-slate-800">
                  {idx + 1}. {c.title}
                  {!c.isRequired ? (
                    <span className="ml-2 text-xs font-normal text-slate-500">(optional)</span>
                  ) : null}
                </h3>
              </div>
              <div
                className="prose prose-sm max-w-none text-slate-600"
                dangerouslySetInnerHTML={{ __html: c.bodyHtml }}
              />
              {c.requiresInitials ? (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Label
                    id={labelId}
                    htmlFor={`initials-${c.id}`}
                    className="shrink-0 text-xs"
                    required={c.isRequired}
                  >
                    Initials{c.isRequired ? '' : ' (optional)'}
                  </Label>
                  {/*
                    Naming the box "Initials, <clause title>" is what makes a
                    screen-reader pass through this form comprehensible — a dozen
                    boxes all called "Initials" are indistinguishable out of
                    context, and this is a legal acknowledgment per clause.
                  */}
                  <Input
                    id={`initials-${c.id}`}
                    value={value}
                    maxLength={6}
                    autoComplete="off"
                    className="w-24 uppercase"
                    aria-labelledby={`${labelId} ${headingId}`}
                    aria-required={c.isRequired || undefined}
                    aria-invalid={showError ? true : undefined}
                    aria-describedby={showError ? errorId : undefined}
                    onChange={(ev) =>
                      setInitials((prev) => ({ ...prev, [c.id]: ev.target.value }))
                    }
                  />
                  {showError ? (
                    <span id={errorId} className="text-xs text-red-600">
                      Please initial to acknowledge.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="signerName" required>
            Signature (type your full legal name)
          </Label>
          <Input
            id="signerName"
            autoComplete="name"
            placeholder="Full legal name"
            value={signerName}
            aria-required
            aria-invalid={touched && !signerName.trim() ? true : undefined}
            aria-describedby={signatureHintId}
            onChange={(e) => setSignerName(e.target.value)}
          />
          <p id={signatureHintId} className="text-xs text-slate-500">
            Typing your full legal name here is your signature on this waiver.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signerDob">Date of birth</Label>
          <Input
            id="signerDob"
            type="date"
            autoComplete="bday"
            value={dob}
            aria-describedby={dobHintId}
            onChange={(e) => setDob(e.target.value)}
          />
          <p id={dobHintId} className="text-xs text-slate-500">
            Used to check whether a parent or guardian also has to sign.
          </p>
        </div>
      </div>

      {/*
        Live region kept in the DOM at all times: the guardian field appears only
        once a date of birth under 18 is entered, and an insertion into an
        already-present polite region is what gets announced.
      */}
      <div aria-live="polite">
        {minor ? (
          <div className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50 p-3">
            <Label htmlFor="guardianName" required>
              Parent / guardian name (required for a minor)
            </Label>
            <Input
              id="guardianName"
              autoComplete="name"
              placeholder="Parent or legal guardian's full name"
              value={guardianName}
              aria-required
              aria-invalid={touched && !guardianName.trim() ? true : undefined}
              aria-describedby={guardianHintId}
              onChange={(e) => setGuardianName(e.target.value)}
            />
            <p id={guardianHintId} className="text-xs text-amber-800">
              By signing, you consent as the parent or legal guardian of the minor participant.
            </p>
          </div>
        ) : null}
      </div>

      {submitError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{submitError}</span>
        </div>
      ) : null}

      <Button
        type="submit"
        variant="brand"
        size="lg"
        className="w-full"
        loading={submitting}
        disabled={submitting}
      >
        {submitting ? 'Signing…' : 'Sign waiver'}
      </Button>

      <p role="status" className="sr-only">
        {submitting ? 'Recording your signature. Please wait.' : ''}
      </p>
    </form>
  );
}
