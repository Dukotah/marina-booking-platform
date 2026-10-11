'use client';

/**
 * ImageUpload — a real file picker for the settings forms, replacing the
 * "paste a URL" text inputs. Drag a logo in, watch it upload, see it.
 *
 * It talks to the API's storage provider (apps/api/src/routes/uploads.ts), which
 * sniffs the file's magic bytes, caps its size, renames it to something random
 * and hands back a public URL. The URL is all this control ever gives its parent
 * form — the form still owns the field, so nothing is persisted until the
 * operator saves, exactly like every other input on the page.
 *
 * WHY XHR AND NOT `fetch`. `fetch` still cannot report upload progress. A logo
 * on a marina's rural DSL is a visible wait, and a control that looks frozen
 * gets clicked again; XHR's `upload.onprogress` is the only way to show the bar,
 * and it gives us a working Cancel for free.
 *
 * WHY THE RAW FILE AS THE BODY. The route reads the body as a stream so it can
 * abort the moment an upload goes over the cap; multipart would have to be
 * buffered first. `xhr.send(file)` sends the bytes as-is, so the two ends agree.
 *
 * The client-side checks below are a courtesy — instant feedback instead of a
 * round trip — never a security boundary. The server re-derives all of them from
 * the bytes themselves, and its answer is the one that counts.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ImageIcon, Loader2, Trash2, UploadCloud, X } from 'lucide-react';
import { cn } from '../../lib/cn';

/** Kept in step with UPLOAD_SCOPES in apps/api/src/services/storage.ts. */
const SCOPE_LIMITS: Record<UploadScope, { maxBytes: number; noun: string }> = {
  branding: { maxBytes: 2 * 1024 * 1024, noun: 'logo' },
  activity: { maxBytes: 8 * 1024 * 1024, noun: 'photo' },
};

/** Mirrors IMAGE_TYPES in the same service. SVG is deliberately absent. */
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif';
const ACCEPT_LABEL = 'PNG, JPEG, GIF, WebP or AVIF';

export type UploadScope = 'branding' | 'activity';

export interface ImageUploadProps {
  /** Field label, e.g. "Logo (dark)". */
  label: string;
  /** Current stored URL. Empty string when nothing is set. */
  value: string;
  /** Called with the new URL after a successful upload, or '' when removed. */
  onChange: (url: string) => void;
  scope?: UploadScope;
  hint?: string;
  /** A validation error from the surrounding form (not from the upload). */
  error?: string;
  /**
   * Preview backdrop. A light logo is invisible on white — the whole reason we
   * keep two of them — so the preview has to be able to show the real context.
   */
  previewTone?: 'light' | 'dark';
  /** Endpoint override. Defaults to `${NEXT_PUBLIC_API_BASE_URL}/uploads`. */
  uploadUrl?: string;
  /** Tenant for the API's tenant middleware (`x-operator-slug`). */
  operatorSlug?: string;
  /** Dev identity when Clerk enforcement is off (`x-dev-staff-id`). */
  staffId?: string;
  /** Clerk session token when it is on (`Authorization: Bearer …`). */
  authToken?: string;
  disabled?: boolean;
  className?: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; percent: number; localPreview: string; name: string }
  | { kind: 'error'; message: string };

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
}

/** The filename from a stored URL, for the "currently: …" line. */
function displayName(url: string): string {
  try {
    const path = new URL(url, 'http://placeholder.invalid').pathname;
    return path.slice(path.lastIndexOf('/') + 1) || url;
  } catch {
    return url;
  }
}

export function ImageUpload({
  label,
  value,
  onChange,
  scope = 'branding',
  hint,
  error,
  previewTone = 'light',
  uploadUrl,
  operatorSlug,
  staffId,
  authToken,
  disabled,
  className,
}: ImageUploadProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  // dragenter/dragleave fire for every child element; count them or the
  // highlight flickers as the pointer crosses the icon.
  const dragDepth = useRef(0);
  const objectUrlRef = useRef<string | null>(null);

  const endpoint = uploadUrl ?? (API_BASE ? `${API_BASE}/uploads` : '');
  const limit = SCOPE_LIMITS[scope];
  const busy = phase.kind === 'uploading';

  const releasePreview = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      xhrRef.current?.abort();
      releasePreview();
    };
  }, [releasePreview]);

  useEffect(() => {
    setPreviewFailed(false);
  }, [value]);

  const send = useCallback(
    (file: File) => {
      if (!endpoint) {
        setPhase({
          kind: 'error',
          message: 'Uploads are not configured — NEXT_PUBLIC_API_BASE_URL is not set.',
        });
        return;
      }
      if (file.size === 0) {
        setPhase({ kind: 'error', message: 'That file is empty. Pick another image.' });
        return;
      }
      if (file.size > limit.maxBytes) {
        setPhase({
          kind: 'error',
          message: `That image is ${formatBytes(file.size)}. A ${limit.noun} has to be under ${formatBytes(limit.maxBytes)} — try exporting it smaller.`,
        });
        return;
      }
      if (file.type && !ACCEPT.split(',').includes(file.type)) {
        setPhase({
          kind: 'error',
          message: `${file.name} is not a ${ACCEPT_LABEL} image.`,
        });
        return;
      }

      releasePreview();
      const localPreview = URL.createObjectURL(file);
      objectUrlRef.current = localPreview;
      setPhase({ kind: 'uploading', percent: 0, localPreview, name: file.name });

      const url = `${endpoint}?scope=${encodeURIComponent(scope)}&filename=${encodeURIComponent(file.name)}`;
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      if (operatorSlug) xhr.setRequestHeader('x-operator-slug', operatorSlug);
      if (staffId) xhr.setRequestHeader('x-dev-staff-id', staffId);
      if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
        setPhase((current) =>
          current.kind === 'uploading' ? { ...current, percent } : current,
        );
      };

      xhr.onload = () => {
        xhrRef.current = null;
        let body: { upload?: { url?: string }; error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText) as typeof body;
        } catch {
          // Fall through to the status-based message below.
        }
        if (xhr.status >= 200 && xhr.status < 300 && body.upload?.url) {
          releasePreview();
          setPhase({ kind: 'idle' });
          onChange(body.upload.url);
          return;
        }
        releasePreview();
        setPhase({ kind: 'error', message: body.error ?? messageForStatus(xhr.status) });
      };

      xhr.onerror = () => {
        xhrRef.current = null;
        releasePreview();
        setPhase({
          kind: 'error',
          message: 'The upload could not reach the server. Check your connection and try again.',
        });
      };

      xhr.onabort = () => {
        xhrRef.current = null;
        releasePreview();
        setPhase({ kind: 'idle' });
      };

      xhr.send(file);
    },
    [authToken, endpoint, limit, onChange, operatorSlug, releasePreview, scope, staffId],
  );

  const pickFirstImage = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      send(file);
    },
    [send],
  );

  function openPicker() {
    if (disabled || busy) return;
    inputRef.current?.click();
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled || busy) return;
    pickFirstImage(event.dataTransfer.files);
  }

  function onDragEnter(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (disabled || busy) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  const describedBy = `${idFor(label)}-help`;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-sm font-medium text-ink-body">{label}</span>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          pickFirstImage(event.target.files);
          // Reset so picking the same file twice in a row still fires onChange.
          event.target.value = '';
        }}
      />

      {value && !busy ? (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
          <div
            className={cn(
              'flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line',
              previewTone === 'dark' ? 'bg-slate-900' : 'bg-surface-muted',
            )}
          >
            {previewFailed ? (
              <ImageIcon className="h-5 w-5 text-ink-muted" aria-hidden />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- operator-supplied URL on an unknown host; next/image would need a remotePatterns entry per tenant
              <img
                src={value}
                alt={`${label} preview`}
                className="max-h-14 max-w-[5.5rem] object-contain"
                onError={() => setPreviewFailed(true)}
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{displayName(value)}</p>
            <p className="truncate text-xs text-ink-muted">
              {previewFailed ? 'This image could not be loaded.' : value}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={openPicker}
              disabled={disabled}
              className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-body transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase({ kind: 'idle' });
                onChange('');
              }}
              disabled={disabled}
              aria-label={`Remove ${label}`}
              className="rounded-lg border border-line-strong bg-surface p-1.5 text-ink-muted transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      ) : busy ? (
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line',
                previewTone === 'dark' ? 'bg-slate-900' : 'bg-surface-muted',
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL for the file being uploaded */}
              <img
                src={phase.localPreview}
                alt=""
                className="max-h-14 max-w-[5.5rem] object-contain opacity-60"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{phase.name}</p>
              <div
                className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
                role="progressbar"
                aria-valuenow={phase.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Uploading ${label}`}
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${phase.percent}%` }}
                />
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Uploading… {phase.percent}%
              </p>
            </div>
            <button
              type="button"
              onClick={() => xhrRef.current?.abort()}
              aria-label="Cancel upload"
              className="shrink-0 rounded-lg border border-line-strong bg-surface p-1.5 text-ink-muted transition-colors hover:bg-surface-muted"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={openPicker}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          disabled={disabled}
          aria-describedby={describedBy}
          className={cn(
            'flex w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            dragging
              ? 'border-accent bg-accent-tint'
              : 'border-line-strong bg-surface hover:border-line-strong hover:bg-surface-muted',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <UploadCloud className="h-5 w-5 text-ink-muted" aria-hidden />
          <span className="text-sm font-medium text-ink-body">
            Drop an image here, or click to choose
          </span>
          <span className="text-xs text-ink-muted">
            {ACCEPT_LABEL} · up to {formatBytes(limit.maxBytes)}
          </span>
        </button>
      )}

      {phase.kind === 'error' ? (
        <p role="alert" className="text-xs font-medium text-rose-600">
          {phase.message}
        </p>
      ) : error ? (
        <p className="text-xs font-medium text-rose-600">{error}</p>
      ) : hint ? (
        <p id={describedBy} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : (
        <span id={describedBy} className="sr-only">
          {`${label}: ${ACCEPT_LABEL}, up to ${formatBytes(limit.maxBytes)}.`}
        </span>
      )}
    </div>
  );
}

/** A stable id fragment from the label, so two controls on a page don't collide. */
function idFor(label: string): string {
  return `upload-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/**
 * Plain-language copy for the failures the server can return. The body's own
 * `error` string wins whenever there is one — these cover the cases where there
 * is no JSON to read (a proxy 502, a dropped connection).
 */
function messageForStatus(status: number): string {
  if (status === 0) return 'The upload was interrupted. Try again.';
  if (status === 401) return 'Your session has expired. Sign in again and retry.';
  if (status === 403) return 'You do not have permission to change this image.';
  if (status === 413) return 'That image is too large.';
  if (status === 415) return `That file is not a ${ACCEPT_LABEL} image.`;
  if (status === 429) return 'Too many uploads in a row. Wait a moment and try again.';
  if (status >= 500) return 'The server could not store that image. Try again in a moment.';
  return `The upload failed (HTTP ${status}).`;
}
