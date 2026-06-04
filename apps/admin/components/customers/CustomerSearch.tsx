'use client';

import { useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';

export interface CustomerSearchProps {
  /** The query param key driving the server-side filter. */
  paramKey?: string;
  placeholder?: string;
}

/**
 * Debounced, URL-driven search box for the customer list. It writes the query to
 * the `q` search param so the server component re-renders a filtered, tenant-
 * scoped result set — no client-side data fetching, no leaking other operators'
 * data. The input stays controlled while a navigation transition is pending so
 * typing feels instant.
 */
export function CustomerSearch({ paramKey = 'q', placeholder = 'Search by name, email, phone, or tag…' }: CustomerSearchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const initial = searchParams.get(paramKey) ?? '';
  const [value, setValue] = useState(initial);

  // Keep local state in sync if the URL changes elsewhere (e.g. back button).
  useEffect(() => {
    setValue(searchParams.get(paramKey) ?? '');
  }, [searchParams, paramKey]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const current = searchParams.get(paramKey) ?? '';
      const next = value.trim();
      if (next === current) return;

      const params = new URLSearchParams(searchParams.toString());
      if (next) {
        params.set(paramKey, next);
      } else {
        params.delete(paramKey);
      }
      const queryString = params.toString();
      startTransition(() => {
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
      });
    }, 300);

    return () => clearTimeout(handle);
  }, [value, paramKey, pathname, router, searchParams]);

  return (
    <div className="relative w-full sm:w-80">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Search customers"
        className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
      />
      {isPending ? (
        <span
          className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
          aria-hidden
        />
      ) : null}
    </div>
  );
}
