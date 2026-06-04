import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and resolve Tailwind conflicts.
 *
 * `clsx` handles conditional/array/object inputs; `tailwind-merge` then dedupes
 * conflicting Tailwind utilities (e.g. `px-2 px-4` -> `px-4`), so consumer
 * `className` props can reliably override component defaults.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
