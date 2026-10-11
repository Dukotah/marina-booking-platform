'use client';

import { useState, useTransition } from 'react';
import { ScanLine, Loader2 } from 'lucide-react';
import { formatUSD } from '@marina/core';
import { cn } from '../../lib/cn';
import { Button, Card, Input } from '../ui';
import { lookupByCode } from '../../app/pos/actions';
import type { CodeLookupResult } from './types';

/**
 * QR / order-code search box for the register. Staff scan a booking QR (which encodes
 * the order number) or type the code to pull up an existing order — to take a balance
 * payment, confirm a guest, or reprint. A hardware scanner acts as a keyboard and
 * submits with Enter, so the form's submit handler covers both scan and manual entry.
 */
export function CodeSearch() {
  const [code, setCode] = useState('');
  const [result, setResult] = useState<CodeLookupResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (!value) return;
    startTransition(async () => {
      const res = await lookupByCode(value);
      setResult(res);
    });
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <div className="relative flex-1">
          <ScanLine
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            type="search"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Scan QR or enter order code…"
            aria-label="Scan QR or enter order code"
            autoComplete="off"
            className="pl-9 uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal"
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={isPending || code.trim().length === 0}
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Look up
        </Button>
      </form>

      {result ? (
        <div
          className={cn(
            'mt-3 rounded-lg border p-3 text-sm',
            result.found
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-line bg-surface-muted text-ink-body',
          )}
        >
          {result.found && result.order ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-semibold">{result.order.orderNumber}</div>
                <div className="text-emerald-800">
                  {result.order.customerName} · {result.order.status}
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold">{formatUSD(result.order.totalCents)}</div>
                {result.order.balanceDueCents > 0 ? (
                  <div className="text-xs text-amber-700">
                    Balance {formatUSD(result.order.balanceDueCents)}
                  </div>
                ) : (
                  <div className="text-xs text-emerald-700">Paid in full</div>
                )}
              </div>
            </div>
          ) : (
            <span>{result.message ?? 'No match found.'}</span>
          )}
        </div>
      ) : null}
    </Card>
  );
}
