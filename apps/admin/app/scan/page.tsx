import { AdminShell } from '../../components/shell/AdminShell';
import { PageHeader } from '../../components/shell/PageHeader';
import { requirePermission } from '../../lib/session';
import { ScanPanel } from './ScanPanel';

export const dynamic = 'force-dynamic';

/**
 * Staff QR check-in. A scanner-as-keyboard (or manual paste) feeds the guest's
 * confirmation QR token to the `checkInByScannedToken` server action, which
 * verifies the HMAC and routes to the same check-in write the day manifest uses.
 * Gated on `order:write` — the permission the check-in action itself requires.
 */
export default async function ScanPage() {
  await requirePermission('order:write');

  return (
    <AdminShell>
      <PageHeader
        title="Scan check-in"
        description="Scan a guest's confirmation QR to check them in, hands-free at the dock."
      />
      <ScanPanel />
    </AdminShell>
  );
}
