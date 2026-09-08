/**
 * Inquiry panel — the booking widget's stand-in for an activity that cannot be
 * booked online yet (no online rate, e.g. the Grand Patio, "Pricing soon").
 *
 * Rather than a booking funnel that leads nowhere, it gives the guest the one
 * thing that does work: the marina's phone, as a tappable call button. When no
 * phone is configured it degrades to a plain "contact the marina" note so the
 * panel never promises an action it cannot fulfill. Server component — no state.
 */
interface InquiryPanelProps {
  activityName: string;
  /** Operator phone, formatted for display, e.g. "(707) 433-2200". */
  phone: string | null;
  /**
   * Legacy prop, retained for call-site compatibility. Estate chrome no longer
   * paints the operator/activity color; the call action is the sage accent.
   */
  accentColor?: string;
}

/** Digits-only tel: href, e.g. "(707) 433-2200" -> "tel:+17074332200". */
function telHref(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return `tel:${e164}`;
}

export function InquiryPanel({ activityName, phone }: InquiryPanelProps) {
  return (
    <div className="rounded-card border border-hairline bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            By reservation
          </p>
          <h2 className="mt-2 font-display text-[19px] tracking-[0.02em] text-ink">
            Reserve the {activityName}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            This space is booked directly with the marina so we can match it to your group and
            date. Give us a call and we will get you set up.
          </p>
        </div>

        {phone ? (
          <>
            <a
              href={telHref(phone)}
              className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-center text-base font-semibold text-white transition-opacity hover:opacity-90"
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
            <p className="text-center text-xs text-muted">
              Tap to call, or dial <span className="tnum">{phone}</span>.
            </p>
          </>
        ) : (
          <p className="rounded-lg border border-hairline bg-surface px-4 py-3 text-sm text-muted">
            Contact the marina to reserve this space.
          </p>
        )}
      </div>
    </div>
  );
}

export default InquiryPanel;
