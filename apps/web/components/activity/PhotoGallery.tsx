'use client';

/**
 * Interactive photo gallery for an activity detail page.
 *
 * Estate photography rules (DESIGN.md): fixed ratios — a 16:9 cover with a 1:1
 * thumbnail strip — radius 14, `object-cover`, and anything drawn over a photo
 * sits on an espresso scrim, never a blur. Shows a large primary image with a
 * thumbnail strip; clicking a thumbnail (or using the prev/next arrows / arrow
 * keys) swaps the primary image. Falls back to a quiet placeholder when the
 * activity has no photos so the layout never collapses — a photo-less layout
 * beats a stock photo.
 *
 * Photos come from arbitrary tenant origins (Cloudflare R2 / external), so we
 * use plain <img> rather than next/image (no per-host config needed).
 */

import { useCallback, useEffect, useState } from 'react';

interface PhotoGalleryProps {
  photoUrls: string[];
  /** Activity name for alt text. */
  name: string;
  /**
   * Legacy prop, retained for call-site compatibility. Estate chrome no longer
   * paints the operator/activity color.
   */
  accentColor?: string;
}

export function PhotoGallery({ photoUrls, name }: PhotoGalleryProps) {
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
        className="flex aspect-video w-full items-center justify-center rounded-card border border-hairline bg-surface"
        role="img"
        aria-label={`${name} — no photos available`}
      >
        <div className="flex flex-col items-center gap-2 text-muted">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span className="text-sm font-medium">Photos coming soon</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Cover photo — 16:9, radius 14. */}
      <div className="group relative aspect-video w-full overflow-hidden rounded-card border border-hairline bg-surface">
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
              className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next photo"
              className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ink"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            {/* Counter on a 55% espresso scrim — the sanctioned way to put text on a photo. */}
            <span className="tnum absolute bottom-3 right-3 rounded-full bg-[rgba(43,36,28,0.55)] px-2.5 py-1 text-xs font-medium text-white">
              {active + 1} / {count}
            </span>
          </>
        )}
      </div>

      {/* Supporting thumbs — 1:1, radius stays in the card family. */}
      {count > 1 && (
        <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1" aria-label="Photo thumbnails">
          {photos.map((url, i) => {
            const selected = i === active;
            return (
              <button
                key={`${url}-${i}`}
                type="button"
                onClick={() => setActive(i)}
                aria-label={`View photo ${i + 1}`}
                aria-current={selected}
                className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-[10px] border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ink ${
                  selected ? 'border-accent' : 'border-transparent hover:border-hairline'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- tenant photo from arbitrary origin */}
                <img
                  src={url}
                  alt=""
                  className={`h-full w-full object-cover transition-opacity ${selected ? '' : 'opacity-70 hover:opacity-100'}`}
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
