import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Book Your Adventure',
  description: 'Reserve boats, watercraft, and waterfront venues.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
