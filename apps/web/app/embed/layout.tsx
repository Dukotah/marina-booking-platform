import type { Metadata, Viewport } from 'next';
import './embed.css';
import { EmbedBridge } from '@/components/embed/EmbedBridge';

/**
 * Layout for the embeddable booking widget.
 *
 * Everything the standalone portal wraps a page in — the site header, the footer,
 * the page-width shell — is deliberately absent: this route only ever renders
 * inside an iframe on the operator's own website, and a second header inside
 * their page would look broken.
 *
 * The layout's other job is to be the stable mount point for `EmbedBridge`. The
 * whole flow (catalog → activity → checkout → confirmation) stays on this one
 * route, changing only its query string, so this layout — and therefore the
 * bridge's ResizeObserver, Escape handler, and host handshake — is mounted once
 * and survives the entire booking.
 *
 * Framing: nothing in this app sets `X-Frame-Options`, so /embed is framable by
 * default. Restricting it to operator-approved domains belongs in
 * `next.config.mjs` `headers()` as a `Content-Security-Policy: frame-ancestors`
 * entry — see docs/EMBED.md.
 */

export const metadata: Metadata = {
  // A widget is a fragment of the operator's site, never a page to rank.
  robots: { index: false, follow: false },
};

// Some in-app browsers scale an iframe's content; pinning the viewport keeps the
// flow at the size the host allotted it.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div id="marina-embed" className="w-full">
      <EmbedBridge />
      {children}
    </div>
  );
}
