/**
 * The shape the readiness board renders.
 *
 * The checks themselves are computed by `lib/readiness.ts` (owned elsewhere) — this
 * file is only the view-side contract, so the board is a pure renderer and stays
 * client-safe. `page.tsx` maps the engine's output onto `ReadinessCheckView` in one
 * place; if the engine's field names shift, that mapping is the only thing to change.
 */

/** Every check lands in exactly one of these. */
export type ReadinessStatus = 'OK' | 'WARN' | 'BLOCKED' | 'NOT_APPLICABLE';

/** Whose move it is. Mixing these two piles is how a client quietly stalls. */
export type ReadinessCourt = 'US' | 'THE_CLIENT';

export interface ReadinessCheckView {
  id: string;
  /** Short name of the thing being checked: "Activities loaded". */
  label: string;
  status: ReadinessStatus;
  /** One plain sentence saying where it stands, in the owner's words. */
  detail: string;
  court: ReadinessCourt;
  /** Deep link into that screen in the client's account; null when there isn't one. */
  href: string | null;
}

export interface StatusMeta {
  /** The status word, spelled out. Status is never carried by colour alone. */
  word: string;
  /** Tailwind classes for the pill. */
  pill: string;
  /** Tailwind text colour for the icon. */
  icon: string;
}

/**
 * Semantic tones on the Clean SaaS light system — muted tinted chips that match
 * the shared Badge tones (success=emerald, waiting=amber, owed=rose, neutral=slate).
 * Status is never carried by colour alone: the word + icon ride along.
 */
export const STATUS_META: Record<ReadinessStatus, StatusMeta> = {
  OK: {
    word: 'Done',
    pill: 'bg-emerald-50 text-emerald-700',
    icon: 'text-emerald-600',
  },
  WARN: {
    word: 'Needs a look',
    pill: 'bg-amber-50 text-amber-700',
    icon: 'text-amber-600',
  },
  BLOCKED: {
    word: 'Blocked',
    pill: 'bg-rose-50 text-rose-700',
    icon: 'text-rose-600',
  },
  NOT_APPLICABLE: {
    word: 'Not needed',
    pill: 'bg-slate-100 text-slate-500',
    icon: 'text-slate-400',
  },
};

/** Open = still costs somebody an action. Sorted worst-first inside a pile. */
export function isOpen(status: ReadinessStatus): boolean {
  return status === 'BLOCKED' || status === 'WARN';
}

const ORDER: Record<ReadinessStatus, number> = {
  BLOCKED: 0,
  WARN: 1,
  OK: 2,
  NOT_APPLICABLE: 3,
};

export function byStatusSeverity(a: ReadinessCheckView, b: ReadinessCheckView): number {
  return ORDER[a.status] - ORDER[b.status] || a.label.localeCompare(b.label);
}
