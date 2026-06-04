'use client';

/**
 * Interactive photo gallery for an activity detail page.
 *
 * Shows a large primary image with a thumbnail strip; clicking a thumbnail (or
 * using the prev/next arrows / arrow keys) swaps the primary image. Falls back
 * to a branded placeholder when the activity has no photos so the layout never
 * collapses.
 *
 * Photos come from arbitrary tenant origins (Cloudflare R2 / external), so we
 * use plain <img> rather than next/image (no per-host config needed).
 */

import { useCallback, useEffect, useState } from 'react';

interface PhotoGalleryProps {
  photoUrls: string[];
  /** Activity name for alt text. */
  name: string;
  /** Activity brand/accent color for the placeholder + active thumbnail ring. */
  accentColor: string;
}

export function PhotoGallery({ photoUrls, name, accentColor }: PhotoGalleryProps) {
  const photos = photoUrls.filter((u) => u && u.trim().length > 0);
  const [active, setActive] = useState(0);

  const hasPhotos = photos.length > 0;
  const count = photos.length;

  const go = useCallback(
    (delta: number) => {
      if (count === 0) return;
      setActive((i) => (i + delta + count) % count);
    },
    [count],
  );

  useEffect(() => {
    if (count <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, go]);

  if (!hasPhotos) {
    return (
      <div
        className="flex aspect-[4/3] w-full items-center justify-center rounded-2xl border border-slate-200 bg-slate-100"
        role="img"
        aria-label={`${name} — no photos available`}
      >
        <div className="flex flex-col items-center gap-2 text-slate-400">
          <span
            aria-hidden
            className="flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{ backgroundColor: accentColor }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </span>
          <span className="text-sm font-medium">No photos yet</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Primary image */}
      <div className="group relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
        {/* eslint-disable-next-line @next/next/no-img-element -- tenant photo from arbitrary origin */}
        <img
          src={photos[active]}
          alt={`${name} — photo ${active + 1} of ${count}`}
          className="h-full w-full object-cover"
        />

        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous photo"
              className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-slate-800 shadow-sm backdrop-blur transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next photo"
              className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-slate-800 shadow-sm backdrop-blur transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <span className="absolute bottom-3 right-3 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white">
              {active + 1} / {count}
            </span>
          </>
        )}
      </div>

      {/* Thumbnail strip */}
      {count > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Photo thumbnails">
          {photos.map((url, i) => {
            const selected = i === active;
            return (
              <button
                key={`${url}-${i}`}
                type="button"
                onClick={() => setActive(i)}
                aria-label={`View photo ${i + 1}`}
                aria-current={selected}
                className="relative h-16 w-20 shrink-0 overflow-hidden rounded-lg border-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                style={{ borderColor: selected ? accentColor : 'transparent' }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- tenant photo from arbitrary origin */}
                <img
                  src={url}
                  alt=""
                  className={`h-full w-full object-cover transition ${selected ? '' : 'opacity-70 hover:opacity-100'}`}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default PhotoGallery;
