// @marina/ui — shared, white-label component library (Tailwind + CVA).
// Primary accents use the CSS var --brand-color so each tenant's branding flows
// through every component. All components accept `className` and forward refs
// where sensible.

export { cn } from './cn.js';

export { Button, buttonVariants, type ButtonProps } from './button.js';
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './card.js';
export { Input, type InputProps } from './input.js';
export { Textarea, type TextareaProps } from './textarea.js';
export { Label, type LabelProps } from './label.js';
export { Select, type SelectProps } from './select.js';
export { Badge, badgeVariants, type BadgeProps } from './badge.js';
export { Spinner, type SpinnerProps } from './spinner.js';
export { Skeleton } from './skeleton.js';
export { Dialog, type DialogProps } from './dialog.js';
export {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from './table.js';
export { Tabs, type TabsProps, type TabItem } from './tabs.js';
export { EmptyState, type EmptyStateProps } from './empty-state.js';
export { StatCard, type StatCardProps } from './stat-card.js';
