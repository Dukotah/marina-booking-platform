// @marina/emails — white-label React Email templates.
//
// Every template takes plain, strongly-typed props (operator branding +
// template data) and renders the operator's brand only — never platform
// branding. Money is passed as integer cents and formatted with formatUSD.

import * as React from 'react';
import { render, type Options as RenderOptions } from '@react-email/components';

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

/**
 * Render a React Email component to an HTML string suitable for sending via
 * Resend (or any transactional email provider).
 *
 * @example
 *   const html = await renderEmail(
 *     BookingConfirmation({ brandName, brandColor, ...data }),
 *   );
 */
export function renderEmail(
  component: React.ReactElement,
  options?: RenderOptions,
): Promise<string> {
  return render(component, options);
}

/**
 * Render a React Email component to a plain-text fallback (good practice to send
 * alongside the HTML part for deliverability).
 */
export function renderEmailText(component: React.ReactElement): Promise<string> {
  return render(component, { plainText: true });
}
