/**
 * Real, scannable check-in QR for a booking confirmation.
 *
 * Server component (Node runtime): it signs an HMAC check-in token for the
 * primary booked item with the shared @marina/core signer, encodes that token
 * into a genuine QR matrix (byte mode, EC level M) with the dependency-free
 * @marina/core encoder, and renders it as an inline SVG. A staff device scans
 * it, then POSTs the token to `/api/checkin/scan`, which verifies the signature
 * and checks the guest in — the same write the day manifest uses.
 *
 * The token is opaque to the guest and unforgeable without the key, so a scanned
 * code cannot be altered to check in someone else's booking. The order number is
 * still shown in plain text beneath as the human-readable fallback.
 *
 * Replaces the earlier deterministic QrPlaceholder (which only *looked* like a
 * QR). Estate tokens only — warm surface, ink modules; never blue/indigo/sky.
 */
import { qrSvg } from '@marina/core';
import { signCheckinToken } from '@marina/core/checkin-token';

export function CheckinQr({
  orderNumber,
  orderItemId,
  size = 160,
}: {
  orderNumber: string;
  orderItemId: string;
  size?: number;
}) {
  const token = signCheckinToken({ orderNumber, orderItemId });
  // Estate palette: ink dark modules on the warm confirmation surface.
  const svg = qrSvg(token, { dark: '#2B241C', light: '#FFFEFB', margin: 2 });

  return (
    <span
      role="img"
      aria-label={`Check-in code for order ${orderNumber}`}
      className="inline-block rounded-lg border border-hairline bg-surface p-2"
      style={{ width: size, height: size }}
      // The encoder output is a trusted, self-contained SVG string (no user HTML).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default CheckinQr;
