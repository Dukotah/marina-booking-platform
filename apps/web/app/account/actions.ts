'use server';

/**
 * Server actions for the customer account area (roadmap 0.7 — customer auth).
 *
 * Real email-OTP sign-in replaces the old order#+email URL stub:
 *   1. `requestOtp` — order number + email → API `request-otp`. The API never
 *      reveals whether the order exists (it returns an unusable decoy challenge on a
 *      mismatch), so this action surfaces the same "we sent a code" UX either way.
 *      In dev (no email provider) the API returns a `devCode` we pass back so the
 *      flow is testable.
 *   2. `verifyOtp` — challenge + code → API `verify-otp`. On success we store the
 *      returned session token in an httpOnly, secure, sameSite=lax cookie and the
 *      client redirects to /account/bookings.
 *   3. `signOutCustomer` — clears the session cookie.
 *
 * Identity now lives in a signed httpOnly cookie, not the URL.
 */

import { cookies } from 'next/headers';
import {
  requestOtp as apiRequestOtp,
  verifyOtp as apiVerifyOtp,
  isApiError,
  CUSTOMER_SESSION_COOKIE,
} from '@/lib/api';

/** Session cookie max age — mirror the API's 7-day session token lifetime. */
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Minimal email shape check — the API is the real gate. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// --- requestOtp -------------------------------------------------------------

export interface RequestOtpSuccess {
  ok: true;
  /** Opaque challenge to submit alongside the code. */
  challenge: string;
  /** Order number, echoed for display + the verify step. */
  orderNumber: string;
  /** Masked-ish hint of where the code went (the email the user typed). */
  email: string;
  /** Present only in dev (no email provider) — lets the UI prefill the code. */
  devCode?: string;
}

export interface ActionFailure {
  ok: false;
  error: string;
}

export type RequestOtpResult = RequestOtpSuccess | ActionFailure;

export async function requestOtp(
  _prev: RequestOtpResult | null,
  formData: FormData,
): Promise<RequestOtpResult> {
  const orderNumber = String(formData.get('orderNumber') ?? '')
    .trim()
    .toUpperCase();
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();

  if (!orderNumber) {
    return { ok: false, error: 'Enter your confirmation (order) number.' };
  }
  if (!looksLikeEmail(email)) {
    return { ok: false, error: 'Enter the email address used for the booking.' };
  }

  try {
    const res = await apiRequestOtp(orderNumber, email);
    return {
      ok: true,
      challenge: res.challenge,
      orderNumber,
      email,
      ...(res.devCode ? { devCode: res.devCode } : {}),
    };
  } catch (err) {
    if (isApiError(err) && err.status === 0) {
      return {
        ok: false,
        error: 'We could not reach the booking system. Please try again in a moment.',
      };
    }
    return {
      ok: false,
      error: 'Something went wrong sending your code. Please try again.',
    };
  }
}

// --- verifyOtp --------------------------------------------------------------

export interface VerifyOtpSuccess {
  ok: true;
}

export type VerifyOtpResult = VerifyOtpSuccess | ActionFailure;

export async function verifyOtp(
  _prev: VerifyOtpResult | null,
  formData: FormData,
): Promise<VerifyOtpResult> {
  const challenge = String(formData.get('challenge') ?? '');
  const code = String(formData.get('code') ?? '').trim();

  if (!challenge) {
    return { ok: false, error: 'Your session expired. Please request a new code.' };
  }
  if (!/^\d{4,8}$/.test(code)) {
    return { ok: false, error: 'Enter the 6-digit code we sent you.' };
  }

  let sessionToken: string;
  try {
    const res = await apiVerifyOtp(challenge, code);
    sessionToken = res.sessionToken;
  } catch (err) {
    if (isApiError(err) && err.status === 0) {
      return {
        ok: false,
        error: 'We could not reach the booking system. Please try again in a moment.',
      };
    }
    // 401 (bad/expired code) and anything else → generic, non-leaking message.
    return { ok: false, error: 'That code is incorrect or has expired. Try again.' };
  }

  cookies().set(CUSTOMER_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return { ok: true };
}

// --- signOut ----------------------------------------------------------------

export async function signOutCustomer(): Promise<void> {
  cookies().delete(CUSTOMER_SESSION_COOKIE);
}
