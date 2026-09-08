/**
 * Graceful notice used by the catalog when there is nothing to show — either the
 * API call failed (error variant) or the operator has no published activities
 * yet (empty variant). Estate states: plain words, one sentence, one action —
 * no emoji, no internal/stacktrace leakage, no platform branding. Server
 * component.
 */

interface CatalogNoticeProps {
  variant: 'error' | 'empty';
}

export function CatalogNotice({ variant }: CatalogNoticeProps) {
  const isError = variant === 'error';

  return (
    <div className="mx-auto max-w-md rounded-card border border-hairline bg-surface px-6 py-16 text-center shadow-card">
      <h2 className="font-display text-[22px] tracking-[0.02em] text-ink">
        {isError ? 'We hit a snag loading bookings' : 'Nothing to book just yet'}
      </h2>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-[1.55] text-muted">
        {isError
          ? 'Our booking catalog is temporarily unavailable. Please refresh in a moment.'
          : 'New experiences are on the way. Check back soon to reserve your spot.'}
      </p>
      {isError && (
        <p className="mt-6 text-[13px] text-muted">
          If this keeps happening, please contact us and we will help you book directly.
        </p>
      )}
    </div>
  );
}

export default CatalogNotice;
