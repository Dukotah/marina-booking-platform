'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { openClientAction } from '../actions';

/** Drops the platform admin into a client's dashboard, then navigates there. */
export function OpenClientButton({ operatorId }: { operatorId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await openClientAction(operatorId);
          router.push('/');
          router.refresh();
        })
      }
      className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
    >
      {pending ? 'Opening…' : 'Open dashboard'}
    </button>
  );
}
