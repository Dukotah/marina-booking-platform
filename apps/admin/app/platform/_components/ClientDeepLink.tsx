'use client';

import { useTransition, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { openClientAction } from '../actions';

/**
 * A link that lands on the right screen IN THE RIGHT ACCOUNT.
 *
 * Admin routes resolve their tenant from the active-operator cookie, so a bare
 * <Link href="/activities"> from the platform console would drop the owner into HIS
 * marina's activities and quietly show him the wrong data. This sets the active
 * client first, then navigates.
 *
 * It stays a real anchor rather than a button: middle-click, copy-link, and the
 * "link" role all keep working, and the Enter key does what the pointer does.
 */
export function ClientDeepLink({
  operatorId,
  href,
  children,
  label,
  className,
}: {
  operatorId: string;
  href: string;
  children?: React.ReactNode;
  /** Screen-reader context, e.g. "Activities in Lake Sonoma Marina's account". */
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const external = /^https?:\/\//i.test(href);

  const styles =
    className ??
    'inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={styles}>
        {children ?? 'Open'}
        {label && <span className="sr-only"> — {label}</span>}
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
      </a>
    );
  }

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // Leave modified clicks alone so "open in a new tab" still behaves; that tab
    // reads the same cookie once this one has set it.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    start(async () => {
      await openClientAction(operatorId);
      router.push(href);
      router.refresh();
    });
  }

  return (
    <a href={href} onClick={onClick} aria-busy={pending || undefined} className={styles}>
      {pending ? 'Opening…' : (children ?? 'Open')}
      {label && <span className="sr-only"> — {label}</span>}
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}
