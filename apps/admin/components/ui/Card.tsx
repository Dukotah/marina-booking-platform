import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface CardProps {
  children: ReactNode;
  className?: string;
}

/**
 * The base surface: a white card with a hairline border and a very soft shadow.
 * Everything that groups content sits on one of these. Pad with `p-4`/`p-5` at
 * the call site, or use SectionCard when you want a titled header built in.
 */
export function Card({ children, className }: CardProps) {
  return (
    <div className={cn('rounded-lg border border-line bg-surface shadow-sm', className)}>
      {children}
    </div>
  );
}

export interface SectionCardProps {
  /** Section title (neutral-900). */
  title: ReactNode;
  /** Optional supporting line under the title. */
  description?: ReactNode;
  /** Right-aligned header actions (a Button, a link, a filter). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Pad the body. Off when the body is a full-bleed table. Default true. */
  bodyPadding?: boolean;
}

/**
 * A Card with a titled header row. Use for every "panel with a heading" on a
 * page so spacing and type are uniform. Set bodyPadding={false} when the body
 * is a DataTable (the table owns its own padding).
 */
export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyPadding = true,
}: SectionCardProps) {
  return (
    <Card className={className}>
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-ink-body">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn(bodyPadding && 'p-5')}>{children}</div>
    </Card>
  );
}
