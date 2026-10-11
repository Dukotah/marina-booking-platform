'use client';

import { Printer } from 'lucide-react';
import { Button } from '../ui';

/**
 * Screen-only "Print" button for the waiver packet page. Triggers the browser
 * print dialog; the print CSS on the page hides all screen chrome so only the
 * legal packet prints.
 */
export function PrintButton() {
  return (
    <Button variant="primary" onClick={() => window.print()}>
      <Printer className="h-4 w-4" aria-hidden />
      Print packet
    </Button>
  );
}
