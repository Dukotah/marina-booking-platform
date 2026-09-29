import { redirect } from 'next/navigation';

/**
 * Gift certificates moved to Catalog → Gift certificates when the sidebar was
 * consolidated (2026-09). The issue/report page lives at
 * /catalog/gift-certificates; ./actions.ts stays here and is imported by the
 * form component, so server-action deep imports keep working.
 */
export default function GiftCertificatesMovedPage(): never {
  redirect('/catalog/gift-certificates');
}
