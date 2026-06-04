/**
 * Money helpers. The entire platform stores money as INTEGER CENTS — these helpers
 * (re-exported from @marina/types so there is a single source of truth) keep that
 * honest. `roundCents` is the canonical rounding used throughout pricing math.
 */
export { toCents, fromCents, formatUSD } from '@marina/types';

/**
 * Round a (possibly fractional) cent value to a whole integer cent using
 * half-up rounding. All money arithmetic that can produce fractions
 * (percentage fees, discounts, taxes) must funnel through this so rounding is
 * consistent and deterministic across the codebase.
 */
export const roundCents = (cents: number): number => Math.round(cents);
