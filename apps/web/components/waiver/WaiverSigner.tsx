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
 */
import { useEffect, useMemo, useState } from 'react';
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setSubmitError(null);
    if (!waiver || !canSubmit) return;

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
    return <p className="text-sm text-slate-500">Loading waiver…</p>;
  }
  if (loadError) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{loadError}</span>
      </div>
    );
  }
  if (!waiver) return null;

  if (signed) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">
        <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden />
        <span>Thank you — your waiver has been signed and recorded.</span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <ShieldCheck className="h-5 w-5 text-[var(--brand-color,#0f766e)]" aria-hidden />
        {waiver.name}
      </div>

      {waiver.introHtml ? (
        <div
          className="prose prose-sm max-w-none text-slate-600"
          // Operator-authored copy.
          dangerouslySetInnerHTML={{ __html: waiver.introHtml }}
        />
      ) : null}

      <ol className="space-y-4">
        {waiver.clauses.map((c, idx) => {
          const value = initials[c.id] ?? '';
          const showError = touched && c.isRequired && c.requiresInitials && !value.trim();
          return (
            <li
              key={c.id}
              className="rounded-lg border border-slate-200 bg-white p-4"
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <h4 className="text-sm font-semibold text-slate-800">
                  {idx + 1}. {c.title}
                  {!c.isRequired ? (
                    <span className="ml-2 text-xs font-normal text-slate-400">(optional)</span>
                  ) : null}
                </h4>
              </div>
              <div
                className="prose prose-sm max-w-none text-slate-600"
                dangerouslySetInnerHTML={{ __html: c.bodyHtml }}
              />
              {c.requiresInitials ? (
                <div className="mt-3 flex items-center gap-3">
                  <Label htmlFor={`initials-${c.id}`} className="shrink-0 text-xs">
                    Initials{c.isRequired ? '' : ' (optional)'}
                  </Label>
                  <Input
                    id={`initials-${c.id}`}
                    value={value}
                    maxLength={6}
                    autoComplete="off"
                    className="w-24 uppercase"
                    aria-invalid={showError ? true : undefined}
                    onChange={(ev) =>
                      setInitials((prev) => ({ ...prev, [c.id]: ev.target.value }))
                    }
                  />
                  {showError ? (
                    <span className="text-xs text-red-600">Please initial to acknowledge.</span>
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
            aria-invalid={touched && !signerName.trim() ? true : undefined}
            onChange={(e) => setSignerName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="signerDob">Date of birth</Label>
          <Input
            id="signerDob"
            type="date"
            autoComplete="bday"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
          />
        </div>
      </div>

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
            aria-invalid={touched && !guardianName.trim() ? true : undefined}
            onChange={(e) => setGuardianName(e.target.value)}
          />
          <p className="text-xs text-amber-700">
            By signing, you consent as the parent or legal guardian of the minor participant.
          </p>
        </div>
      ) : null}

      {submitError ? (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{submitError}</span>
        </div>
      ) : null}

      {touched && missingRequired.length > 0 ? (
        <p className="text-sm text-amber-700">
          Please initial all required sections before signing.
        </p>
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
    </form>
  );
}
