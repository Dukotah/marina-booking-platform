'use server';

/**
 * Server actions for passwordless customer login (email-OTP, D-017).
 *
 * Step 1 (`requestCode`): ask the API to email a 6-digit code. In non-prod when
 * email isn't delivered the API returns the code (`devCode`) so the flow is
 * completable locally — we pass it back to the form for convenience.
 *
 * Step 2 (`verifyCode`): exchange email + code for a signed session token, store
 * it in an httpOnly cookie, and redirect to the post-login destination.
 *
 * Both return friendly, customer-safe messages rather than throwing, so the form
 * can render inline state.
 */

import { redirect } from 'next/navigation';
import {
  requestCustomerLoginCode,
  verifyCustomerLoginCode,
  isApiError,
} from '@/lib/api';
import { setCustomerSession } from '@/lib/session';

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Only allow same-app relative paths as a redirect target (no open redirect). */
function safeNext(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  return v.startsWith('/') && !v.startsWith('//') ? v : '/account';
}

export interface RequestCodeState {
  ok: boolean;
  /** Echoed normalized email, carried into the verify step. */
  email: string;
  /** Present only in non-prod when the code wasn't emailed — shown as a dev hint. */
  devCode?: string;
  /** Human-readable message (success hint or error). */
  message?: string;
  error?: string;
}

export async function requestCode(
  _prev: RequestCodeState | null,
  formData: FormData,
): Promise<RequestCodeState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();

  if (!looksLikeEmail(email)) {
    return { ok: false, email, error: 'Enter a valid email address.' };
  }

  try {
    const result = await requestCustomerLoginCode(email);
    return {
      ok: true,
      email,
      devCode: result.devCode,
      message: result.sent
        ? 'We emailed you a 6-digit code. It expires in 10 minutes.'
        : 'Enter the 6-digit code to continue.',
    };
  } catch (err) {
    if (isApiError(err) && err.status === 0) {
      return { ok: false, email, error: 'We could not reach the login service. Please try again in a moment.' };
    }
    return { ok: false, email, error: isApiError(err) ? err.message : 'Something went wrong. Please try again.' };
  }
}

export interface VerifyCodeState {
  ok: boolean;
  error?: string;
}

export async function verifyCode(
  _prev: VerifyCodeState | null,
  formData: FormData,
): Promise<VerifyCodeState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const code = String(formData.get('code') ?? '').trim();
  const next = safeNext(String(formData.get('next') ?? ''));

  if (!looksLikeEmail(email)) {
    return { ok: false, error: 'Your session expired. Please request a new code.' };
  }
  if (!/^\d{4,8}$/.test(code)) {
    return { ok: false, error: 'Enter the numeric code we sent you.' };
  }

  try {
    const result = await verifyCustomerLoginCode(email, code);
    setCustomerSession({ token: result.token, email: result.customer.email ?? email }, result.expiresInSeconds);
  } catch (err) {
    if (isApiError(err) && err.status === 0) {
      return { ok: false, error: 'We could not reach the login service. Please try again in a moment.' };
    }
    return { ok: false, error: isApiError(err) ? err.message : 'That code is incorrect or expired.' };
  }

  // Outside the try/catch: redirect() throws a control-flow signal we must not swallow.
  redirect(next);
}
