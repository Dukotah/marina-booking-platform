import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AdminShell, PageHeader } from '../../components/shell';
import { getTenantDb } from '../../lib/session';
import { MessageInbox } from '../../components/dev/MessageInbox';

export const metadata: Metadata = {
  title: 'Local Console',
};

export const dynamic = 'force-dynamic';

/**
 * The Local Console — the owner's testing surface when the product runs with no
 * external accounts (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 * Today it shows the sandbox inbox: every confirmation, reminder, refund receipt
 * and staff alert the system "sent", email and SMS alike, rendered exactly as the
 * customer would have received it. Payment-outcome controls, webhook replay and
 * clock jumping land here next.
 *
 * HARD GATE: this route must not exist when the app runs against real providers.
 * `sandboxEnabled()` is mirrored from the API service rather than imported, since
 * the admin app talks to the database directly (D-007) and does not depend on the
 * API package.
 */
function sandboxEnabled(): boolean {
  const flag = process.env.SANDBOX?.trim().toLowerCase();
  if (flag === 'local') return true;
  if (flag === 'cloud') return false;
  return process.env.NODE_ENV !== 'production';
}

export default async function DevConsolePage() {
  if (!sandboxEnabled()) notFound();

  const db = await getTenantDb();
  const messages = await db.sandboxMessage.findMany({
    orderBy: { created_at: 'desc' },
    take: 100,
  });

  const emails = messages.filter((m) => m.channel === 'EMAIL').length;
  const texts = messages.filter((m) => m.channel === 'SMS').length;

  return (
    <AdminShell>
      <PageHeader
        title="Local Console"
        description="Everything the system sent while running locally. No Resend or Twilio account involved — messages are rendered exactly as they would be delivered, then stored here."
      />
      <MessageInbox
        messages={messages.map((m) => ({
          id: m.id,
          channel: m.channel,
          kind: m.kind,
          to: m.to_address,
          from: m.from_address,
          subject: m.subject,
          html: m.body_html,
          text: m.body_text,
          orderNumber: m.order_number,
          createdAt: m.created_at.toISOString(),
        }))}
        emailCount={emails}
        smsCount={texts}
      />
    </AdminShell>
  );
}
