'use client';

/**
 * Sign-out control for the customer account area. Calls the `signOutCustomer`
 * server action (which clears the httpOnly session cookie) then returns to the
 * account landing page. White-label: neutral styling, no platform branding.
 */

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { signOutCustomer } from './actions';

export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await signOutCustomer();
          router.push('/account');
          router.refresh();
        })
      }
      className="text-sm font-medium text-slate-500 transition hover:text-slate-800 disabled:opacity-60"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
