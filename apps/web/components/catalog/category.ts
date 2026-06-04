/**
 * Display helpers for activity categories on the customer catalog.
 *
 * The API returns the canonical SCREAMING_SNAKE category enum (see
 * @/lib/api ActivityCategory). Customers should see friendly, pluralized labels
 * and a small icon glyph — kept here so cards, filters, and section headings all
 * agree. No platform or operator branding lives here.
 */
import type { ActivityCategory } from '@/lib/api';

interface CategoryMeta {
  /** Pluralized, customer-facing label, e.g. "Boats". */
  label: string;
  /** Singular label for "1 result"-style copy. */
  singular: string;
  /** A single emoji glyph used as a lightweight icon on color headers. */
  glyph: string;
}

const CATEGORY_META: Record<ActivityCategory, CategoryMeta> = {
  BOAT: { label: 'Boats', singular: 'Boat', glyph: '\u{1F6A4}' }, // motor boat
  WATERCRAFT: { label: 'Watercraft', singular: 'Watercraft', glyph: '\u{1F30A}' }, // wave
  PATIO: { label: 'Patios & Venues', singular: 'Patio', glyph: '\u{1F305}' }, // sunrise
  LODGING: { label: 'Lodging', singular: 'Stay', glyph: '\u{1F3E1}' }, // house
  TOUR: { label: 'Tours', singular: 'Tour', glyph: '\u{1F9ED}' }, // compass
  CLASS: { label: 'Classes', singular: 'Class', glyph: '\u{1F393}' }, // grad cap
  EVENT: { label: 'Events', singular: 'Event', glyph: '\u{1F389}' }, // party
  EQUIPMENT: { label: 'Equipment', singular: 'Equipment', glyph: '\u{1F392}' }, // backpack
  OTHER: { label: 'More', singular: 'Activity', glyph: '\u{2728}' }, // sparkles
};

const FALLBACK: CategoryMeta = { label: 'Activities', singular: 'Activity', glyph: '\u{2728}' };

function meta(category: ActivityCategory): CategoryMeta {
  return CATEGORY_META[category] ?? FALLBACK;
}

/** Pluralized, customer-facing category label, e.g. "Boats". */
export function categoryLabel(category: ActivityCategory): string {
  return meta(category).label;
}

/** Emoji glyph for a category, used on the color header of a card. */
export function categoryGlyph(category: ActivityCategory): string {
  return meta(category).glyph;
}

/** Stable display order so the catalog and filter chips read consistently. */
export const CATEGORY_ORDER: ActivityCategory[] = [
  'BOAT',
  'WATERCRAFT',
  'PATIO',
  'LODGING',
  'TOUR',
  'CLASS',
  'EVENT',
  'EQUIPMENT',
  'OTHER',
];

/** Sort a set of categories into the canonical display order. */
export function sortCategories(categories: ActivityCategory[]): ActivityCategory[] {
  const present = new Set(categories);
  return CATEGORY_ORDER.filter((c) => present.has(c));
}
