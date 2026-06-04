/**
 * Check-in instructions and cancellation policy panels for the confirmation
 * screen.
 *
 * These are generic, white-label texts: they reference the operator's brand
 * name (passed in) rather than any specific marina, and avoid platform branding.
 * The self-reschedule window and detailed policy ultimately live on the operator
 * /activity records; until that endpoint is exposed on the order payload, this
 * presents sensible, operator-neutral defaults so the customer always sees clear
 * guidance.
 */

function PanelIcon({ kind }: { kind: 'checkin' | 'policy' }) {
  if (kind === 'checkin') {
    return (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    );
  }
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export function CheckInInstructions({ brandName }: { brandName: string }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-slate-900">
        <span style={{ color: 'var(--brand-color)' }}>
          <PanelIcon kind="checkin" />
        </span>
        <h2 className="text-base font-semibold">Check-in instructions</h2>
      </div>
      <ul className="space-y-2 text-sm text-slate-600">
        <li className="flex gap-2">
          <span aria-hidden className="text-slate-400">
            •
          </span>
          Arrive 15 minutes before your start time so the {brandName} team can get
          you checked in and on your way.
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-slate-400">
            •
          </span>
          Bring a photo ID for the reservation holder and have your order number or
          this confirmation ready.
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-slate-400">
            •
          </span>
          Show the code at the top of this page when you arrive — the staff can scan
          or look up your order number directly.
        </li>
        <li className="flex gap-2">
          <span aria-hidden className="text-slate-400">
            •
          </span>
          All guests in your party should be present at check-in to complete any
          required waivers.
        </li>
      </ul>
    </section>
  );
}

export function CancellationPolicy({ brandName }: { brandName: string }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-slate-900">
        <span className="text-slate-400">
          <PanelIcon kind="policy" />
        </span>
        <h2 className="text-base font-semibold">Cancellation policy</h2>
      </div>
      <p className="text-sm text-slate-600">
        Plans change — we get it. You can cancel or reschedule your reservation up
        to 24 hours before your start time for a full refund. Cancellations made
        within 24 hours of the start time may not be eligible for a refund. To make
        a change, look up your booking or contact the {brandName} team and have your
        order number handy.
      </p>
    </section>
  );
}
