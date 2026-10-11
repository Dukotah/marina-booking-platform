'use client';

import { useState, useTransition } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { PrimaryButton, SecondaryButton, SaveStatus, type SaveState } from './fields';
import type { IntegrationDef } from './integrationCatalog';
import {
  rotateCalendarFeedToken,
  setCalendarFeedEnabled,
} from '../../app/settings/actions';

/**
 * The Calendar-feed integration card. Unlike the generic key/value
 * IntegrationCard, the credential here is a server-generated secret token — the
 * operator never types anything. The card offers:
 *  - Generate (first time) / Rotate (thereafter — invalidates the old URL),
 *  - the read-only subscribe URL with a copy button, and
 *  - one-line instructions for Google Calendar (works the same in Apple
 *    Calendar and Outlook: subscribe by URL).
 *
 * `apiBaseUrl` is resolved server-side on the integrations page (the API's
 * public base), so the displayed URL is exactly what Google will poll.
 */
export function CalendarFeedCard({
  def,
  initialToken,
  initialEnabled,
  apiBaseUrl,
}: {
  def: IntegrationDef;
  initialToken: string | null;
  initialEnabled: boolean;
  apiBaseUrl: string;
}) {
  const [token, setToken] = useState<string | null>(initialToken);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  const feedUrl = token ? `${apiBaseUrl.replace(/\/+$/, '')}/calendar/feed/${token}.ics` : null;
  const live = enabled && Boolean(token);

  function generate() {
    // Rotating kills every previously shared URL — make that explicit.
    if (token && !window.confirm('Rotate the feed token? The current URL will stop working and every subscribed calendar must be re-added with the new one.')) {
      return;
    }
    setSaveState({ kind: 'idle' });
    startTransition(async () => {
      const result = await rotateCalendarFeedToken();
      if (result.ok && result.token) {
        setToken(result.token);
        setEnabled(true);
        setSaveState({ kind: 'saved' });
      } else {
        setSaveState({ kind: 'error', message: result.message ?? 'Could not update the feed token.' });
      }
    });
  }

  function toggleEnabled(next: boolean) {
    setSaveState({ kind: 'idle' });
    setEnabled(next);
    startTransition(async () => {
      const result = await setCalendarFeedEnabled(next);
      if (!result.ok) {
        setEnabled(!next);
        setSaveState({ kind: 'error', message: result.message ?? 'Could not update the feed.' });
      } else {
        setSaveState({ kind: 'saved' });
      }
    });
  }

  async function copyUrl() {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (http, permissions) — select-and-copy still works.
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{def.name}</h3>
            {live ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                <Check className="h-3 w-3" aria-hidden /> Live
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-ink-muted">{def.description}</p>
        </div>
        {token ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-2">
            <span className="sr-only">Enable {def.name}</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => toggleEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-line-strong text-accent accent-accent focus:ring-focus"
            />
          </label>
        ) : null}
      </div>

      <div className="space-y-4 px-5 py-5">
        {feedUrl ? (
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-body" htmlFor="calendar-feed-url">
              Feed URL <span className="font-normal text-ink-muted">(secret — anyone with it can see your schedule)</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                id="calendar-feed-url"
                readOnly
                value={feedUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-xs text-ink-body focus:outline-none focus:ring-2 focus:ring-focus"
              />
              <SecondaryButton type="button" onClick={copyUrl}>
                {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                <span className="sr-only sm:not-sr-only sm:ml-1.5">{copied ? 'Copied' : 'Copy'}</span>
              </SecondaryButton>
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              In Google Calendar: <span className="font-medium text-ink-body">Other calendars → + → From URL</span>,
              paste the feed URL. Apple Calendar: File → New Calendar Subscription. Outlook: Add calendar →
              Subscribe from web. Bookings appear and update automatically (Google refreshes every few hours).
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-body">
            Generate a secret feed URL, then subscribe to it from Google Calendar, Apple Calendar, or
            Outlook — every booking shows up on your calendar with guest, party size, waiver, and
            balance details, and stays up to date as bookings change.
          </p>
        )}

        <div className="flex items-center justify-end gap-3">
          <SaveStatus state={saveState} savedLabel="Updated" />
          <PrimaryButton type="button" onClick={generate} disabled={isPending}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
            {isPending ? 'Working…' : token ? 'Rotate token' : 'Generate feed URL'}
          </PrimaryButton>
        </div>
      </div>
    </section>
  );
}
