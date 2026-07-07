// Render on demand: Next 14.2's static export of /_not-found trips a framework
// useContext error when the root layout mounts a client provider (ClerkProvider).
// force-dynamic sidesteps the static prerender. (Simple, hook-free content.)
export const dynamic = 'force-dynamic';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-bold text-slate-900">Page not found</h1>
      <p className="text-sm text-slate-600">That page doesn’t exist in the operator console.</p>
      <a
        href="/"
        className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
      >
        Back to dashboard
      </a>
    </div>
  );
}
