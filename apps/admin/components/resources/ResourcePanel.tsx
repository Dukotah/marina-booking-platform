'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ResourceForm } from './ResourceForm';
import type { ResourceListItem, SelectOption } from './types';

/**
 * Slide-over panel housing the ResourceForm. Traps focus on open, dismisses
 * on Escape, and calls onClose when the form completes or the user cancels.
 * Keeps the form's state isolated so it resets cleanly on every open.
 */
export function ResourcePanel({
  open,
  mode,
  resource,
  locations,
  activities,
  onClose,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  resource?: ResourceListItem & { activityIds?: string[] };
  locations: SelectOption[];
  activities: SelectOption[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Restore focus when panel closes
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement;
      // Move focus into the panel
      setTimeout(() => {
        const first = panelRef.current?.querySelector<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), button:not([disabled])',
        );
        first?.focus();
      }, 50);
    } else {
      triggerRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30 bg-black/30 transition-opacity"
        aria-hidden
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? 'Add resource' : 'Edit resource'}
        className={cn(
          'fixed inset-y-0 right-0 z-40 flex w-full max-w-lg flex-col bg-white shadow-2xl',
          'sm:w-[520px]',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">
            {mode === 'create' ? 'Add resource' : 'Edit resource'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close panel"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Re-mount the form on each open so state resets cleanly */}
          <ResourceForm
            key={resource?.id ?? 'new'}
            mode={mode}
            resource={resource}
            locations={locations}
            activities={activities}
            onSuccess={onClose}
            onCancel={onClose}
          />
        </div>
      </div>
    </>
  );
}
