/**
 * Inquiry panel — the booking widget's stand-in for an activity that cannot be
 * booked online yet (no online rate, e.g. the Grand Patio, "Pricing soon").
 *
 * Rather than a booking funnel that leads nowhere, it gives the guest the one
 * thing that does work: the marina's phone, as a tappable call button. When no
 * phone is configured it degrades to a plain "contact the marina" note so the
 * panel never promises an action it cannot fulfill. Server component — no state.
 */
import { onBrandForeground } from '@/lib/brand';

interface InquiryPanelProps {
  activityName: string;
  /** Operator phone, formatted for display, e.g. "(707) 433-2200". */
  phone: string | null;
  /** The activity's accent color, for the call button. */
  accentColor: string;
}

/** Digits-only tel: href, e.g. "(707) 433-2200" -> "tel:+17074332200". */
function telHref(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return `tel:${e164}`;
}

export function InquiryPanel({ activityName, phone, accentColor }: InquiryPanelProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-4">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            By reservation
          </span>
          <h2 className="mt-3 text-lg font-semibold text-slate-900">Reserve the {activityName}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
            This space is booked directly with the marina so we can match it to your group and
            date. Give us a call and we will get you set up.
          </p>
        </div>

        {phone ? (
          <>
            <a
              href={telHref(phone)}
              className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-center text-base font-semibold shadow-sm transition hover:opacity-90"
              style={{ backgroundColor: accentColor, color: onBrandForeground(accentColor) }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
              Call {phone}
            </a>
            <p className="text-center text-xs text-slate-500">
              Tap to call, or dial {phone}.
            </p>
          </>
        ) : (
          <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Contact the marina to reserve this space.
          </p>
        )}
      </div>
    </div>
  );
}

export default InquiryPanel;
