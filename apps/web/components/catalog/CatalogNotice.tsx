/**
 * Graceful notice used by the catalog when there is nothing to show — either the
 * API call failed (error variant) or the operator has no published activities
 * yet (empty variant). Customer-friendly copy, no internal/stacktrace leakage,
 * no platform branding. Server component.
 */

interface CatalogNoticeProps {
  variant: 'error' | 'empty';
}

export function CatalogNotice({ variant }: CatalogNoticeProps) {
  const isError = variant === 'error';

  return (
    <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
      <span aria-hidden className="text-4xl">
        {isError ? '\u{26F5}' : '\u{1F5D3}\u{FE0F}'}
      </span>
      <h2 className="mt-4 text-lg font-semibold text-slate-900">
        {isError ? 'We hit a snag loading bookings' : 'Nothing to book just yet'}
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">
        {isError
          ? 'Our booking catalog is temporarily unavailable. Please refresh in a moment — your reservation options will be right back.'
          : 'New experiences are on the way. Check back soon to reserve your spot.'}
      </p>
      {isError && (
        <p className="mt-6 text-xs text-slate-400">
          If this keeps happening, please contact us and we will help you book directly.
        </p>
      )}
    </div>
  );
}

export default CatalogNotice;
