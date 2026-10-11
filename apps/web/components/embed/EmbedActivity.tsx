/**
 * Activity step of the embedded widget.
 *
 * A compact header (photos, name, capacity, "from" price) above the portal's real
 * `BookingWidget` — the same rate cards, availability calendar, time-slot picker
 * and capacity clamping the standalone activity page uses. When the widget's
 * "Continue to checkout" pushes `/checkout?…`, the embed router turns that into
 * the checkout step of this same route.
 *
 * Deliberately not the full activity page: marketing copy and a two-column layout
 * do not belong in a 380px-wide panel on someone else's site. The description is
 * offered as a disclosure so the operator's detail is still reachable.
 */

import type { ActivityDetail } from '@/lib/api';
import { formatUSD } from '@/lib/format';
import { PhotoGallery } from '@/components/activity/PhotoGallery';
import { BookingWidget } from '@/components/activity/BookingWidget';

interface EmbedActivityProps {
  activity: ActivityDetail;
}

export function EmbedActivity({ activity }: EmbedActivityProps) {
  const guests =
    activity.minParticipants === activity.maxParticipants
      ? `${activity.maxParticipants} guests`
      : `${activity.minParticipants}–${activity.maxParticipants} guests`;

  return (
    <div className="px-3 py-4">
      <PhotoGallery
        photoUrls={activity.photoUrls}
        name={activity.name}
        accentColor={activity.color}
      />

      <header className="mt-4">
        <h1 className="text-xl font-bold leading-tight tracking-tight text-slate-900">
          {activity.name}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
          <span>{guests}</span>
          {activity.fromPriceCents != null && (
            <span className="font-semibold text-slate-900">
              from {formatUSD(activity.fromPriceCents)}
            </span>
          )}
          {activity.waiverRequired && <span className="text-slate-500">Waiver required</span>}
        </div>
      </header>

      {activity.descriptionHtml && (
        <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <summary className="cursor-pointer list-none text-sm font-medium text-slate-700 marker:hidden">
            About this experience
          </summary>
          <div
            className="mt-2 space-y-2 text-sm leading-relaxed text-slate-600 [&_a]:text-[color:var(--brand-color)] [&_a]:underline [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1"
            // Operator-authored rich text. Sanitized to a safe allowlist on write
            // (activity schema) AND again server-side in GET /api/activities/:id
            // before it reaches this embed — see @marina/core sanitizeHtml.
            dangerouslySetInnerHTML={{ __html: activity.descriptionHtml }}
          />
        </details>
      )}

      <div className="mt-4">
        <BookingWidget activity={activity} />
      </div>

      <p className="mt-3 text-center text-xs text-slate-400">
        Free self-reschedule up to {activity.selfRescheduleHours} hours before your start
        time.
      </p>
    </div>
  );
}

export default EmbedActivity;
