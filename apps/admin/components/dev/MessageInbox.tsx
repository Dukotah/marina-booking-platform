'use client';

/**
 * Sandbox inbox — a two-pane mail client for everything the system "sent"
 * locally. Left: the message list, filterable by channel. Right: the message as
 * the recipient would see it (the real rendered HTML for email, the actual text
 * body for SMS).
 *
 * Client component because selecting and filtering should feel instant; the data
 * itself is loaded server-side by app/dev/page.tsx.
 */
import { useMemo, useState } from 'react';

export interface SandboxMessageView {
  id: string;
  channel: 'EMAIL' | 'SMS';
  kind: string;
  to: string;
  from: string | null;
  subject: string | null;
  html: string | null;
  text: string | null;
  orderNumber: string | null;
  createdAt: string;
}

interface MessageInboxProps {
  messages: SandboxMessageView[];
  emailCount: number;
  smsCount: number;
}

type Filter = 'ALL' | 'EMAIL' | 'SMS';

/** booking_confirmation -> "Booking confirmation" */
function prettyKind(kind: string): string {
  const s = kind.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function MessageInbox({ messages, emailCount, smsCount }: MessageInboxProps) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(messages[0]?.id ?? null);

  const visible = useMemo(
    () => (filter === 'ALL' ? messages : messages.filter((m) => m.channel === filter)),
    [messages, filter],
  );
  const selected = visible.find((m) => m.id === selectedId) ?? visible[0] ?? null;

  if (messages.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <p className="text-sm font-medium text-slate-900">No messages yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          Take a booking on the customer site at{' '}
          <a
            href="http://localhost:3000"
            className="font-medium text-sky-600 underline-offset-2 hover:underline"
          >
            localhost:3000
          </a>{' '}
          and the confirmation email, the confirmation text, and the staff alert will all land
          here.
        </p>
      </div>
    );
  }

  const tabs: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'ALL', label: 'All', count: messages.length },
    { key: 'EMAIL', label: 'Email', count: emailCount },
    { key: 'SMS', label: 'SMS', count: smsCount },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setFilter(t.key)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              filter === t.key
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {t.label}
            <span className="ml-1.5 opacity-60">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {/* List */}
        <ul className="max-h-[34rem] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white">
          {visible.map((m) => {
            const active = selected?.id === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(m.id)}
                  className={`w-full px-4 py-3 text-left transition ${
                    active ? 'bg-sky-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        m.channel === 'EMAIL'
                          ? 'bg-indigo-100 text-indigo-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {m.channel}
                    </span>
                    <span className="truncate text-xs font-medium text-slate-500">
                      {prettyKind(m.kind)}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                      {relativeTime(m.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm font-medium text-slate-900">
                    {m.subject ?? m.text ?? '(no subject)'}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    to {m.to}
                    {m.orderNumber ? ` · ${m.orderNumber}` : ''}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Preview */}
        <div className="rounded-xl border border-slate-200 bg-white">
          {selected ? (
            <>
              <div className="space-y-1 border-b border-slate-100 px-5 py-4">
                <p className="text-sm font-semibold text-slate-900">
                  {selected.subject ?? prettyKind(selected.kind)}
                </p>
                <p className="text-xs text-slate-500">
                  {selected.from ? `${selected.from} → ` : ''}
                  {selected.to}
                </p>
                <p className="text-xs text-slate-400">
                  {new Date(selected.createdAt).toLocaleString()}
                  {selected.orderNumber ? ` · order ${selected.orderNumber}` : ''}
                </p>
              </div>
              {selected.channel === 'EMAIL' && selected.html ? (
                // The message is our own rendered template, not third-party input.
                <iframe
                  title="Message preview"
                  srcDoc={selected.html}
                  sandbox=""
                  className="h-[28rem] w-full rounded-b-xl bg-white"
                />
              ) : (
                <div className="p-5">
                  <div className="max-w-sm rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-slate-800 ring-1 ring-emerald-100">
                    <p className="whitespace-pre-wrap">{selected.text ?? '(empty message)'}</p>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="p-10 text-center text-sm text-slate-500">Select a message.</p>
          )}
        </div>
      </div>
    </div>
  );
}
