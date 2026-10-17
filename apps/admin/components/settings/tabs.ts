import {
  TrendingUp,
  Palette,
  ShieldCheck,
  Receipt,
  Fuel,
  MapPin,
  Plug,
  UserCog,
  Ship,
  FileSignature,
  ListChecks,
  MessageSquare,
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
 *
 * Lives in a plain (non-'use client') module so BOTH the client SettingsNav and
 * the server settings hub page can import it. Exporting this array from the
 * client component turned it into a client reference, so the server page's
 * `SETTINGS_TABS.map()` threw "map is on the client".
 */
export const SETTINGS_TABS: SettingsTab[] = [
  { label: 'Branding', href: '/settings/branding', icon: Palette, description: 'Name, logo, brand color' },
  { label: 'Policies', href: '/settings/policies', icon: ShieldCheck, description: 'Adult age, cancellation, check-in' },
  { label: 'Waivers', href: '/settings/waivers', icon: FileSignature, description: 'Liability waiver text & clauses' },
  { label: 'Customer Questions', href: '/settings/questions', icon: ListChecks, description: 'Extra checkout fields & details' },
  { label: 'Message Templates', href: '/settings/messages', icon: MessageSquare, description: 'Confirmation, reminder & refund copy' },
  { label: 'Fees & Taxes', href: '/settings/fees', icon: Receipt, description: 'Taxes, processing, custom fees' },
  { label: 'Charge Presets', href: '/settings/charges', icon: Fuel, description: 'Reusable fuel, cleaning & damage charges' },
  { label: 'Pricing', href: '/settings/pricing', icon: TrendingUp, description: 'Seasons, weekends, demand' },
  { label: 'Locations', href: '/settings/locations', icon: MapPin, description: 'Sites & addresses' },
  { label: 'Resources', href: '/settings/resources', icon: Ship, description: 'Shared boats, gear & guides' },
  { label: 'Integrations', href: '/settings/integrations', icon: Plug, description: 'Payments, accounting, marketing' },
  { label: 'Staff', href: '/settings/staff', icon: UserCog, description: 'Team members & roles' },
];
