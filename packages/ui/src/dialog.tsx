'use client';

import { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn.js';

export interface DialogProps {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Called when the user requests to close (overlay click, Escape, close button). */
  onClose: () => void;
  /** Accessible dialog title. Rendered in the header and wires aria-labelledby. */
  title?: React.ReactNode;
  /** Optional supporting text shown under the title. */
  description?: React.ReactNode;
  /** Footer area, typically for action buttons. */
  footer?: React.ReactNode;
  /** Hide the default top-right close button. */
  hideCloseButton?: boolean;
  /** Disable closing when the backdrop is clicked. */
  disableBackdropClose?: boolean;
  className?: string;
  children?: React.ReactNode;
}

let dialogIdSeq = 0;

/**
 * A simple controlled modal. Deliberately portal-less: it renders a `fixed`
 * full-viewport overlay so it works in any app without a portal root. Handles
 * Escape to close, backdrop click, body scroll lock, and basic focus capture.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  hideCloseButton = false,
  disableBackdropClose = false,
  className,
  children,
}: DialogProps): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number>();
  if (idRef.current === undefined) {
    idRef.current = ++dialogIdSeq;
  }
  const titleId = `dialog-title-${idRef.current}`;
  const descId = `dialog-desc-${idRef.current}`;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    // Move focus into the panel for keyboard + screen-reader users.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = overflow;
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (!disableBackdropClose && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl outline-none',
          className,
        )}
      >
        {(title || !hideCloseButton) && (
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-6">
            <div className="flex flex-col gap-1">
              {title ? (
                <h2
                  id={titleId}
                  className="text-lg font-semibold leading-none tracking-tight text-slate-900"
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p id={descId} className="text-sm text-slate-500">
                  {description}
                </p>
              ) : null}
            </div>
            {!hideCloseButton ? (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-color,#0f766e)]"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            ) : null}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-6">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
