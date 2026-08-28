// @marina/emails — white-label React Email templates.
//
// Every template takes plain, strongly-typed props (operator branding +
// template data) and renders the operator's brand only — never platform
// branding. Money is passed as integer cents and formatted with formatUSD.

import * as React from 'react';
import { render, type Options as RenderOptions } from '@react-email/components';
import { stripUnsafeControlChars } from './sanitize.js';

// Shared layout + branding contract.
export {
  BrandLayout,
  type BrandProps,
  type BrandLayoutProps,
} from './components/BrandLayout.js';

// Templates.
export {
  BookingConfirmation,
  type BookingConfirmationProps,
  type PriceLine,
} from './BookingConfirmation.js';
export {
  BookingReminder,
  type BookingReminderProps,
} from './BookingReminder.js';
export { RefundReceipt, type RefundReceiptProps } from './RefundReceipt.js';
export { WaiverRequest, type WaiverRequestProps } from './WaiverRequest.js';
export {
  StaffNewBooking,
  type StaffNewBookingProps,
} from './StaffNewBooking.js';

export type { Options as RenderEmailOptions } from '@react-email/components';

// The render-boundary guard. Both helpers below run their output through it, so a
// rendered body can never carry a character a text column or a mail transport
// cannot hold. See sanitize.ts for why that belongs here and not at the one
// consumer that happens to persist today.
export {
  stripUnsafeControlChars,
  findUnsafeControlChars,
  formatCodePoint,
  type UnsafeCharacter,
} from './sanitize.js';

/**
 * Best-effort name for the component being rendered, used only to make the guard's
 * warning point somewhere. Templates are usually invoked as plain function calls
 * (`StaffNewBooking({...})`), so the element we get back is already the layout the
 * template returned — expect a layout name rather than a template name.
 */
function componentLabel(component: React.ReactElement): string {
  const type = component.type as string | { displayName?: string; name?: string };
  if (typeof type === 'string') return type;
  return type?.displayName ?? type?.name ?? 'unknown';
}

/**
 * Render a React Email component to an HTML string suitable for sending via
 * Resend (or any transactional email provider).
 *
 * @example
 *   const html = await renderEmail(
 *     BookingConfirmation({ brandName, brandColor, ...data }),
 *   );
 */
export async function renderEmail(
  component: React.ReactElement,
  options?: RenderOptions,
): Promise<string> {
  const html = await render(component, options);
  return stripUnsafeControlChars(html, `renderEmail(${componentLabel(component)})`);
}

/**
 * Render a React Email component to a plain-text fallback (good practice to send
 * alongside the HTML part for deliverability).
 */
export async function renderEmailText(component: React.ReactElement): Promise<string> {
  // The plain-text pass runs html-to-text over the same HTML, so it inherits any
  // corruption the HTML render introduced and needs the same guard.
  const text = await render(component, { plainText: true });
  return stripUnsafeControlChars(text, `renderEmailText(${componentLabel(component)})`);
}
