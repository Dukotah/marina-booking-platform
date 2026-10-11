// Shared Clean SaaS primitives. Page builders import from here:
//   import { Button, Card, SectionCard, StatCard, Badge, Input, Select } from '@/components/ui';
// (or the relative '../../components/ui'). Keep the API small and obvious.
export {
  Button,
  buttonClasses,
  BUTTON_VARIANTS,
  BUTTON_SIZES,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './Button';
export { Card, SectionCard, type CardProps, type SectionCardProps } from './Card';
export { StatCard, type StatCardProps } from './StatCard';
export { Badge, BADGE_TONES, type BadgeProps, type BadgeTone } from './Badge';
export { Input, Select, FieldLabel, type InputProps, type SelectProps } from './Input';
// PageHeader + DataTable live in components/shell (long-standing import path);
// re-exported here so builders have one place to look.
export { PageHeader, type PageHeaderProps } from '../shell/PageHeader';
export { DataTable, type DataTableProps, type Column } from '../shell/DataTable';
