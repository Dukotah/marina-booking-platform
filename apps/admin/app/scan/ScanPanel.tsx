'use client';

import { useRef, useState, useTransition } from 'react';
import { Check, Loader2, QrCode, XCircle } from 'lucide-react';
import { Button, Input, FieldLabel, Card } from '../../components/ui';
import { checkInByScannedToken } from '../manifest/actions';

/**
 * Staff "Scan" entry point. A QR/barcode scanner behaves as a keyboard: focus
 * the field, scan the guest's confirmation QR, and the decoded token lands in
 * the input followed by Enter — which submits straight to the server action.
 * Manual paste works too (e.g. a token copied from a support ticket).
 *
 * The server action verifies the HMAC and routes to the same check-in write the
 * manifest tap uses; this component only drives the input + shows the outcome.
 * Clean-SaaS teal tokens, 44px targets.
 */

type Outcome = { kind: 'ok' } | { kind: 'error'; message: string };

export function ScanPanel() {
  const [token, setToken] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function submit() {
    const value = token.trim();
    if (!value || pending) return;
    startTransition(async () => {
      const res = await checkInByScannedToken(value);
      if (res.ok) {
        setOutcome({ kind: 'ok' });
      } else {
        setOutcome({ kind: 'error', message: res.error ?? 'Check-in failed.' });
      }
      // Clear + refocus so the next guest can be scanned immediately.
      setToken('');
      inputRef.current?.focus();
    });
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-accent-tint p-2 text-accent-ink">
            <QrCode className="h-5 w-5" aria-hidden />
          </div>
          <div className="flex-1">
            <FieldLabel htmlFor="scan-token">Scan or paste a check-in code</FieldLabel>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Input
                id="scan-token"
                ref={inputRef}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="Point the scanner at the guest's QR…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <div className="mt-3 flex justify-end">
                <Button type="submit" disabled={pending || !token.trim()}>
                  {pending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking in…
                    </>
                  ) : (
                    'Check in'
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </Card>

      {outcome?.kind === 'ok' ? (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800"
        >
          <Check className="h-5 w-5 shrink-0" aria-hidden />
          <p className="text-sm font-medium">Checked in. Guest is good to go.</p>
        </div>
      ) : null}

      {outcome?.kind === 'error' ? (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-800"
        >
          <XCircle className="h-5 w-5 shrink-0" aria-hidden />
          <p className="text-sm font-medium">{outcome.message}</p>
        </div>
      ) : null}
    </div>
  );
}

export default ScanPanel;
