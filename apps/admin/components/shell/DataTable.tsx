// No 'use client': this is a shared, render-only table. Server list pages
// (orders, activities) render it directly and pass `cell` render functions —
// which is only legal when the component is a Server Component. The two client
// callers (CustomerTable, BookingHistory) import it into their client bundle,
// where `onRowClick` still works. Adding 'use client' here breaks the server
// pages with "Functions cannot be passed directly to Client Components".
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface Column<T> {
  /** Stable column id; also used as the React key for cells. */
  id: string;
  /** Column header label. */
  header: ReactNode;
  /** Cell renderer for a row. */
  cell: (row: T) => ReactNode;
  /** Right-align numeric columns (money, counts). */
  align?: 'left' | 'right' | 'center';
  /** Optional fixed/utility width classes (e.g. "w-32"). */
  className?: string;
  /** Optional header-only extra classes. */
  headerClassName?: string;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  /** Stable React key per row. */
  getRowKey: (row: T, index: number) => string;
  /** Shown when there are no rows. */
  emptyState?: ReactNode;
  /**
   * Accessible name for the table, announced when a screen-reader user lands on it.
   * Rendered as a visually hidden <caption>: several of these tables sit under a
   * short "Items"/"Payments" heading that a table-navigation command never reads,
   * which leaves the reader in an unnamed grid of numbers. (1.3.1)
   */
  caption?: string;
  /** Optional row click handler (client usage). */
  onRowClick?: (row: T) => void;
  className?: string;
}

const alignClass: Record<NonNullable<Column<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/**
 * Generic, tenant-agnostic table used by list pages (orders, customers,
 * activities, staff). Strongly typed over the row shape, with per-column
 * renderers, alignment, an empty state, and optional row interaction.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  emptyState,
  caption,
  onRowClick,
  className,
}: DataTableProps<T>) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm',
        className,
      )}
    >
      {/*
        A region that scrolls has to be reachable by keyboard, or a keyboard-only
        operator simply cannot see the columns that overflow — on the dock, on a
        narrow screen, that is most of them. tabIndex makes it focusable and the
        caption names it, so a screen reader announces WHICH table just took focus
        rather than an anonymous scroll box.
      */}
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label={caption ? `${caption} (scrollable)` : 'Scrollable table'}
      >
        <table className="w-full border-collapse text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left">
              {columns.map((col) => (
                <th
                  key={col.id}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500',
                    alignClass[col.align ?? 'left'],
                    col.className,
                    col.headerClassName,
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-slate-500">
                  {emptyState ?? 'No records to display.'}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={getRowKey(row, index)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-slate-50',
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cn(
                        'whitespace-nowrap px-4 py-3 text-slate-700',
                        alignClass[col.align ?? 'left'],
                        col.className,
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
