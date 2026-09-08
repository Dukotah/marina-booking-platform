'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Link2, QrCode, X } from 'lucide-react';
import { qrSvg } from '@marina/core';

/**
 * Staff-side distribution controls for one unsigned waiver:
 *
 *  - "Copy link" puts the customer signer URL on the clipboard so staff can
 *    text/email it to the guest.
 *  - "QR" opens a full-screen dock/kiosk overlay with a large QR code — staff
 *    hold up the phone/tablet, the guest scans it and signs on their own device.
 *
 * The QR is generated locally by @marina/core's dependency-free encoder (SVG,
 * so it stays crisp at any size). No guest or financial data is in the code —
 * only the sign URL.
 */
export function SignLinkActions({
  signUrl,
  /** Who/what the link is for, used in the accessible names + overlay caption. */
  label,
  /** Compact icon-only buttons for dense tables. */
  compact = false,
}: {
  signUrl: string;
  label: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(signUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (http, permissions); the QR still works.
    }
  }

  const buttonClass =
    'inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 ' +
    (compact ? 'px-1.5 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs font-medium');

  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" onClick={copy} aria-label={`Copy waiver sign link for ${label}`} className={buttonClass}>
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
        ) : (
          <Link2 className="h-3.5 w-3.5" aria-hidden />
        )}
        {copied ? 'Copied' : 'Copy link'}
      </button>
      <button
        type="button"
        onClick={() => setShowQr(true)}
        aria-label={`Show waiver QR code for ${label}`}
        className={buttonClass}
      >
        <QrCode className="h-3.5 w-3.5" aria-hidden />
        QR
      </button>
      {showQr ? <QrOverlay signUrl={signUrl} label={label} onClose={() => setShowQr(false)} /> : null}
    </span>
  );
}

/**
 * Full-screen "scan to sign" overlay for the dock. Big QR, big instruction,
 * nothing else — it is meant to be held up to a guest.
 */
function QrOverlay({
  signUrl,
  label,
  onClose,
}: {
  signUrl: string;
  label: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const svg = useMemo(() => qrSvg(signUrl, { margin: 4 }), [signUrl]);

  // Focus the close control and close on Escape — this overlay swallows the page.
  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Waiver QR code for ${label}`}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-slate-900/95 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* qrSvg output is generated locally from the URL — trusted content. */}
        <div
          className="aspect-square w-full [&_svg]:h-full [&_svg]:w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="text-center text-white" onClick={(e) => e.stopPropagation()}>
        <p className="text-2xl font-bold">Scan to sign your waiver</p>
        <p className="mt-1 text-sm text-slate-300">
          Point your phone camera at the code, then sign on your own device.
        </p>
        <p className="mt-2 text-xs text-slate-400">{label}</p>
      </div>
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-500 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800"
      >
        <X className="h-4 w-4" aria-hidden /> Close
      </button>
    </div>
  );
}
