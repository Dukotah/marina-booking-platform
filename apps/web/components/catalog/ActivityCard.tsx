/**
 * A single activity card in the catalog browse section — "Estate" styling.
 *
 * A quiet photo card: 4:3 photograph (radius 14 via the card), the name, one
 * muted meta line, and an all-in "from $" price. Per DESIGN.md there are no
 * per-card buttons, badges or pills — the whole card is the link, and the one
 * sage action on the page belongs to the departures board, not the catalog.
 * Money is always integer cents formatted via the shared helper. No platform
 * or hardcoded operator branding.
 */
import Link from 'next/link';
import { formatUSD } from '@/lib/format';
import type { CatalogActivity } from '@/lib/api';
import { categoryGlyph, categoryLabel } from './category';

interface ActivityCardProps {
  activity: CatalogActivity;
  /** Operator phone; when the activity can only be booked by calling, the card
   *  dials this instead of opening a dead booking page. */
  contactPhone?: string | null;
}

/** Digits-only tel: href from a formatted phone, e.g. "(707) 433-2200" -> "tel:+17074332200". */
function telHref(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  // US 10-digit numbers get the +1 country code; anything else is passed through.
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return `tel:${e164}`;
}

export function ActivityCard({ activity, contactPhone }: ActivityCardProps) {
  const photo = activity.photoUrls[0] ?? null;
  const bookable = activity.fromPriceCents != null && activity.rates.length > 0;

  // An activity with no online rate (e.g. the Grand Patio, "Pricing soon") cannot
  // be booked in the funnel — its detail page has no booking widget. If we know the
  // marina's phone, turn the whole card into a call-to-inquire so it actually does
  // something; otherwise fall back to the detail page as before.
  const inquire = !bookable && !!contactPhone;
  const href = inquire
    ? telHref(contactPhone as string)
    : `/activities/${encodeURIComponent(activity.id)}`;
  const cardClass =
    'group flex h-full flex-col overflow-hidden rounded-card border border-hairline bg-surface shadow-card outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-ink focus-visible:ring-offset-2';

  const cardBody = (
    <>
      {/* Photo: fixed 4:3, object-cover. Photo-less activities get a calm
          surface panel with the category glyph — better than a stock photo. */}
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-bg">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant photos from arbitrary origins
          <img
            src={photo}
            alt={activity.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted">
            <span aria-hidden className="text-4xl opacity-60">
              {categoryGlyph(activity.category)}
            </span>
          </div>
        )}
      </div>

      {/* Body: name, one muted meta line, all-in from-price. Nothing else. */}
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="text-base font-medium leading-snug text-ink transition-colors group-hover:text-accent-ink">
          {activity.name}
        </h3>
        <p className="text-sm text-muted">
          {categoryLabel(activity.category)} · up to{' '}
          <span className="tnum">{activity.maxParticipants}</span>
          {inquire ? ' · call to reserve' : ''}
        </p>
        <p className="mt-auto pt-2 text-sm text-ink">
          {bookable ? (
            <>
              from{' '}
              <span className="tnum font-semibold">
                {formatUSD(activity.fromPriceCents as number)}
              </span>
            </>
          ) : (
            <span className="text-muted">Pricing soon</span>
          )}
        </p>
      </div>
    </>
  );

  // A tel: target is a plain anchor (Next's <Link> is for in-app routes); a
  // bookable activity keeps the client-side <Link> to its detail page.
  if (inquire) {
    return (
      <a href={href} aria-label={`Inquire about ${activity.name} by phone`} className={cardClass}>
        {cardBody}
      </a>
    );
  }

  return (
    <Link href={href} className={cardClass}>
      {cardBody}
    </Link>
  );
}

export default ActivityCard;
