'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { exitClientAction } from '../../app/platform/actions';

/** Shown across the top when a platform admin has "opened" a client. */
export function ExitImpersonationBanner({ clientName }: { clientName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center justify-center gap-3 bg-emerald-600 px-4 py-1.5 text-center text-xs font-medium text-white">
      <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
      <span>
        Viewing <strong>{clientName}</strong> as platform admin
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await exitClientAction();
            router.push('/platform');
            router.refresh();
          })
        }
        className="rounded bg-emerald-700/60 px-2 py-0.5 font-semibold transition hover:bg-emerald-700 disabled:opacity-50"
      >
        {pending ? 'Exiting…' : 'Exit to Platform'}
      </button>
    </div>
  );
}
