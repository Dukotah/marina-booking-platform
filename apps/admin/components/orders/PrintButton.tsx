'use client';

import { Printer } from 'lucide-react';

/**
 * Screen-only "Print" button for the waiver packet page. Triggers the browser
 * print dialog; the print CSS on the page hides all screen chrome so only the
 * legal packet prints.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-md bg-slate-800 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-700"
    >
      <Printer className="h-4 w-4" aria-hidden />
      Print packet
    </button>
  );
}
