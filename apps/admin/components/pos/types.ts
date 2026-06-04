/**
 * Shared types for the integrated POS terminal.
 *
 * These are the serializable shapes passed from the POS server component into the
 * client terminal, plus the in-memory cart/line representations the terminal works
 * with locally before a sale is submitted. All money is integer cents.
 */

/** Payment methods the register accepts. Mirrors the relevant PaymentMethod enum members. */
export type PosPaymentMethod = 'CASH' | 'CARD';

/** Which entry tab a line item came from. Drives how we persist it at checkout. */
export type CartLineKind = 'BOOKING' | 'MERCHANDISE' | 'MISC';

/** A bookable rate for an activity, surfaced for walk-up sales. */
export interface PosRate {
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
}

/** A bookable timeslot for an activity on the working day. */
export interface PosTimeslot {
  id: string;
  /** ISO datetime string (UTC) — formatted client-side in the operator's locale. */
  datetime: string;
  capacityTotal: number;
  capacityBooked: number;
  status: 'AVAILABLE' | 'FILLING_UP' | 'FULL';
}

/** An activity available for walk-up booking at the register. */
export interface PosActivity {
  id: string;
  name: string;
  category: string;
  color: string;
  maxParticipants: number;
  rates: PosRate[];
  timeslots: PosTimeslot[];
}

/** A merchandise item available for sale. */
export interface PosMerchandise {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  /** Null when stock isn't tracked for this item. */
  onHandQty: number | null;
}

/** The pricing fees configured for this operator (tax/processing/surcharges). */
export interface PosFee {
  name: string;
  type: 'PERCENT' | 'FLAT';
  value: number;
}

/** White-label + register configuration handed to the terminal. */
export interface PosConfig {
  operatorName: string;
  /** Default customer used for anonymous walk-up sales (resolved server-side). */
  defaultCustomerId: string | null;
  fees: PosFee[];
}

/** A line in the cart. Discriminated by `kind`. */
export interface CartLine {
  /** Client-side unique key for the line. */
  key: string;
  kind: CartLineKind;
  /** Display label shown in the cart. */
  label: string;
  /** Optional secondary line (e.g. rate + timeslot, category). */
  sublabel?: string;
  unitPriceCents: number;
  quantity: number;
  // --- Booking-only fields (present when kind === 'BOOKING') ---
  activityId?: string;
  rateId?: string;
  timeslotId?: string;
  // --- Merchandise-only fields ---
  merchandiseId?: string;
}

/** Payload submitted to the checkout server action. */
export interface SaleInput {
  lines: Array<{
    kind: CartLineKind;
    label: string;
    unitPriceCents: number;
    quantity: number;
    activityId?: string;
    rateId?: string;
    timeslotId?: string;
    merchandiseId?: string;
  }>;
  paymentMethod: PosPaymentMethod;
  tipCents: number;
  /** Cash tendered, in cents — used to compute change for CASH sales. */
  cashTenderedCents?: number;
  /** Optional customer details captured at the register; falls back to walk-up. */
  customer?: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
  };
}

/** Result returned to the terminal after a checkout attempt. */
export interface SaleResult {
  ok: boolean;
  orderId?: string;
  orderNumber?: string;
  totalCents?: number;
  changeDueCents?: number;
  error?: string;
}

/** A code/QR lookup hit (order match). */
export interface CodeLookupResult {
  found: boolean;
  order?: {
    id: string;
    orderNumber: string;
    customerName: string;
    status: string;
    totalCents: number;
    balanceDueCents: number;
  };
  message?: string;
}
