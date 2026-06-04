import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { AdminShell } from '../../components/shell';
import { SettingsNav } from '../../components/settings/SettingsNav';

export const metadata: Metadata = {
  title: 'Settings',
};

/**
 * Settings shell — wraps every settings page in the admin chrome plus the grouped
 * settings sub-navigation. Grouped, searchable settings are a core wedge vs.
 * Singenuity's 18+ unsearchable settings pages.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <AdminShell>
      <SettingsNav />
      {children}
    </AdminShell>
  );
}
