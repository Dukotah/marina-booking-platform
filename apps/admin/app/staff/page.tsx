import { redirect } from 'next/navigation';

/**
 * Staff & Roles moved under Settings when the sidebar was consolidated
 * (2026-09). ./actions.ts stays here — the staff components import it and the
 * server-action module path is part of the running contract.
 */
export default function StaffMovedPage(): never {
  redirect('/settings/staff');
}
