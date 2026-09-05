import type { ListingImageView } from '@machiya/shared';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';

/**
 * The listing gallery.
 *
 * Only READY images are shown: a PENDING row is an upload the worker has not
 * decoded, and it has no servable bytes at all (docs/images.md). A listing
 * whose photos are all pending shows the empty state rather than a row of
 * broken image icons.
 *
 * The dominant colour and the inline LQIP hold each frame before the full image
 * paints, so paging through never flashes white.
 */
export interface GalleryProps {
  images: ListingImageView[];
  title: string;
  className?: string;
}

export function Gallery({ images, title, className }: GalleryProps) {
  const ready = images.filter((image) => image.status === 'READY' && image.urls);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const reduced = useReducedMotion();

  const current = ready[index];

  if (ready.length === 0) {
    return (
      <div
        className={cn(
          'flex aspect-16/10 w-full flex-col items-center justify-center gap-2 rounded-chrome bg-paper-sunken',
          className,
        )}
      >
        <ImageOff className="size-6 text-ink-faint" aria-hidden />
        <p className="text-label text-ink-soft">
          {images.length > 0 ? 'Photos are still being processed' : 'No photos yet'}
        </p>
      </div>
    );
  }

  const go = (step: number): void => {
    setDirection(step);
    setIndex((value) => (value + step + ready.length) % ready.length);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        className="relative aspect-16/10 w-full overflow-hidden rounded-chrome bg-paper-sunken"
        style={current?.dominantColor ? { backgroundColor: current.dominantColor } : undefined}
      >
        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
          <motion.img
            key={current?.id ?? index}
            src={current?.urls?.full ?? ''}
            alt={`${title} — photo ${String(index + 1)} of ${String(ready.length)}`}
            width={current?.width ?? 1600}
            height={current?.height ?? 1000}
            className="absolute inset-0 size-full object-cover"
            // Directional: forward and back are different, so the slide says
            // which way you went.
            initial={reduced ? false : { opacity: 0, x: direction * 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 1 } : { opacity: 0, x: direction * -24 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          />
        </AnimatePresence>

        {ready.length > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              className="chrome absolute top-1/2 left-2 grid size-8 -translate-y-1/2 place-items-center"
            >
              <ChevronLeft className="size-4" aria-hidden />
              <span className="sr-only">Previous photo</span>
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              className="chrome absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center"
            >
              <ChevronRight className="size-4" aria-hidden />
              <span className="sr-only">Next photo</span>
            </button>
            <span className="text-data chrome absolute right-2 bottom-2 px-1.5 py-0.5">
              {index + 1}/{ready.length}
            </span>
          </>
        ) : null}
      </div>

      {ready.length > 1 ? (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {ready.map((image, position) => (
            <button
              key={image.id}
              type="button"
              onClick={() => {
                setDirection(position > index ? 1 : -1);
                setIndex(position);
              }}
              aria-current={position === index}
              className={cn(
                'aspect-4/3 w-16 shrink-0 overflow-hidden rounded-inset border-2',
                position === index ? 'border-signal' : 'border-transparent opacity-70',
              )}
              style={image.dominantColor ? { backgroundColor: image.dominantColor } : undefined}
            >
              <img
                src={image.urls?.thumb ?? ''}
                alt=""
                loading="lazy"
                className="size-full object-cover"
              />
              <span className="sr-only">Show photo {position + 1}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* Dev-only and gated on the build flag: the seeded photographs are from
          Unsplash, whose terms require credit. The per-photographer list lives
          in docs/attribution.md, which is a path for us and not a thing to show
          anyone (docs/ux-audit.md 1.14). */}
      {import.meta.env.DEV ? (
        <p className="text-data text-ink-faint">
          Sample photos from{' '}
          <a
            href="https://unsplash.com"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            Unsplash
          </a>
        </p>
      ) : null}
    </div>
  );
}
