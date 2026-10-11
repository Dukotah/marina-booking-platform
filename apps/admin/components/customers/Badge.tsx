// Thin alias kept for the existing customer call sites (CustomerTable, TagInput).
// The real implementation is the shared primitive in components/ui — this stays a
// tone-neutral tag chip so operator-defined tags never collide with status colors.
export { Badge, type BadgeProps } from '../ui/Badge';
