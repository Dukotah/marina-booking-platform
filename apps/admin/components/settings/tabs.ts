/**
 * Settings tab registry — client-safe (no `'use client'`, no server-only).
 *
 * Kept separate from `SettingsNav.tsx` (which is a Client Component) so a Server
 * Component — e.g. the settings hub page — can import and map over the list
 * without pulling a client module into the server graph (which throws
 * "Attempted to call map() from the server but map is on the client").
 */
import {
  Palette,
  ShieldCheck,
  Receipt,
  MapPin,
  Plug,
  UserCog,
  FileSignature,
  type LucideIcon,
} from 'lucide-react';

export interface SettingsTab {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
}

/**
 * Grouped settings navigation — the deliberate contrast to Singenuity's 18+
 * unsearchable settings pages. A small, sensible set of groups instead of a
 * sprawling list. "Staff" links into the dedicated staff slice.
 */
export const SETTINGS_TABS: SettingsTab[] = [
  { label: 'Branding', href: '/settings/branding', icon: Palette, description: 'Name, logo, brand color' },
  { label: 'Policies', href: '/settings/policies', icon: ShieldCheck, description: 'Adult age, cancellation, check-in' },
  { label: 'Fees & Taxes', href: '/settings/fees', icon: Receipt, description: 'Taxes, processing, custom fees' },
  { label: 'Locations', href: '/settings/locations', icon: MapPin, description: 'Sites & addresses' },
  { label: 'Integrations', href: '/settings/integrations', icon: Plug, description: 'Payments, accounting, marketing' },
  { label: 'Waivers', href: '/settings/waivers', icon: FileSignature, description: 'Versioned liability waiver templates' },
  { label: 'Staff', href: '/staff', icon: UserCog, description: 'Team members & roles' },
];
