import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'Marina Admin',
  description: 'Operator dashboard, manifest, and POS.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <html lang="en">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );

  // Only mount ClerkProvider when Clerk is actually configured. In local dev the
  // keys are frequently absent (see lib/session dev fallback); wrapping without a
  // publishable key would crash the whole app, so we render plain instead.
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return body;
  }

  return <ClerkProvider>{body}</ClerkProvider>;
}
