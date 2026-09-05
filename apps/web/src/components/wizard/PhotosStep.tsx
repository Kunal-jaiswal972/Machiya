import {
  MAX_IMAGES_PER_LISTING,
  type ListingDraftView,
  type ListingImageView,
} from '@machiya/shared';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  CircleAlert,
  ImageUp,
  Loader2,
  RotateCcw,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useListingImages } from '../../hooks/use-listing-images';
import { cn } from '../../lib/utils';
import { EmptyState } from '../EmptyState';
import { Button } from '../ui/button';

/**
 * Photos, on top of the pipeline that already exists.
 *
 * The upload goes browser-to-storage through a presigned POST and the API never
 * sees a byte (D34, D36). Reordering and cover selection are metadata updates
 * that never re-run derivation (D41).
 *
 * The four image states need four different things from the user and are shown
 * as four different things:
 *
 *  - **PENDING** — the worker has not decoded it yet. A spinner, not an error.
 *    Reading as a broken upload is the specific failure to avoid here, because
 *    the usual response to a broken upload is to delete and retry, which throws
 *    away a photo that was about to become fine.
 *  - **REJECTED** — the file is the problem and no retry will help (D38). The
 *    reason is shown verbatim and the only action is to remove it.
 *  - **FAILED** — our side gave up after retries. Removing and re-uploading is
 *    a reasonable thing to try, so that is what is offered.
 *  - **READY** — a photo, with a cover control.
 */
export interface PhotosStepProps {
  draft: ListingDraftView;
}

export function PhotosStep({ draft }: PhotosStepProps) {
  const images = draft.images;
  const { uploads, upload, reorder, remove, invalidate } = useListingImages(
    draft.id,
    images.length,
  );

  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reduced = useReducedMotion();

  const processing = images.some((image) => image.status === 'PENDING');

  /**
   * Poll while anything is still being decoded.
   *
   * Derivation is a queue job with retries and backoff, so there is no push to
   * subscribe to. Three seconds is short enough that a normal photo appears to
   * process instantly and long enough that a wizard left open on a slow machine
   * is not a request every second.
   */
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(invalidate, 3000);
    return () => {
      window.clearInterval(timer);
    };
  }, [processing, invalidate]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const { rejected, overflow } = await upload(files);

      for (const name of rejected) {
        toast.error(`${name} is not a JPEG, PNG, WebP or HEIC`);
      }
      if (overflow) {
        toast.error(`A listing can have at most ${String(MAX_IMAGES_PER_LISTING)} photos`);
      }
    },
    [upload],
  );

  const move = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const order = images.map((image) => image.id);
    const from = order.indexOf(fromId);
    const to = order.indexOf(toId);
    if (from === -1 || to === -1) return;

    order.splice(to, 0, ...order.splice(from, 1));

    try {
      await reorder(order);
    } catch {
      toast.error('Could not reorder those');
    }
  };

  const removeImage = async (imageId: string) => {
    try {
      await remove(imageId);
      toast.success('Photo removed');
    } catch {
      toast.error('Could not remove that photo');
    }
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-4 pb-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => {
          setDragOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void addFiles([...event.dataTransfer.files]);
        }}
        className={cn(
          'rounded-[var(--radius-chrome)] border-2 border-dashed p-6 text-center transition-colors',
          dragOver ? 'border-water bg-water-soft' : 'border-edge-strong',
        )}
      >
        <ImageUp className="mx-auto size-6 text-ink-faint" aria-hidden />
        <p className="text-label mt-2">Drop photos here</p>
        <p className="text-data mt-0.5 text-ink-soft">
          JPEG, PNG or WebP. Large photos are shrunk before they leave your machine.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => inputRef.current?.click()}
        >
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          className="sr-only"
          onChange={(event) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </div>

      {uploads.length > 0 ? (
        <ul className="grid gap-1.5">
          {uploads.map((entry) => (
            <li key={entry.key} className="chrome p-2">
              <p className="text-label truncate">{entry.name}</p>
              {entry.error ? (
                <p className="text-data mt-0.5 text-clay">{entry.error}</p>
              ) : (
                <div className="mt-1 h-1 w-full rounded-full bg-paper-sunken">
                  <div
                    className="h-1 rounded-full bg-water transition-[width]"
                    style={{ width: `${String(Math.round(entry.progress * 100))}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {images.length === 0 && uploads.length === 0 ? (
        <EmptyState
          illustration="listing"
          title="No photos yet"
          detail="One is enough to publish, but the first is the one people see in the list — make it the room you would show first."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <AnimatePresence initial={false}>
            {images.map((image) => (
              <motion.li
                key={image.id}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                transition={reduced ? { duration: 0 } : { duration: 0.18 }}
                draggable={image.status === 'READY'}
                onDragStart={() => {
                  setDragging(image.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDrop={() => {
                  if (dragging) void move(dragging, image.id);
                  setDragging(null);
                }}
              >
                <PhotoTile
                  image={image}
                  onMakeCover={() => {
                    void move(image.id, images[0]?.id ?? image.id);
                  }}
                  onRemove={() => {
                    void removeImage(image.id);
                  }}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

function PhotoTile({
  image,
  onMakeCover,
  onRemove,
}: {
  image: ListingImageView;
  onMakeCover: () => void;
  onRemove: () => void;
}) {
  return (
    <figure className="chrome overflow-hidden">
      <div
        className="relative aspect-[4/3] w-full"
        style={{ backgroundColor: image.dominantColor ?? 'var(--color-paper-sunken)' }}
      >
        {image.urls ? (
          <img
            src={image.urls.card}
            alt=""
            className="size-full object-cover"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <StatusOverlay image={image} />
        )}

        {image.isCover && image.status === 'READY' ? (
          <span className="text-data absolute top-1 left-1 rounded-[var(--radius-inset)] bg-signal px-1.5 py-0.5 text-signal-ink">
            Cover
          </span>
        ) : null}
      </div>

      <figcaption className="flex items-center justify-between gap-1 p-1.5">
        <span className="text-data truncate text-ink-soft">
          {image.status === 'READY'
            ? `${String(image.width)}×${String(image.height)}`
            : STATUS_LABEL[image.status]}
        </span>
        <span className="flex shrink-0 gap-0.5">
          {image.status === 'READY' && !image.isCover ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Make this the cover photo"
              onClick={onMakeCover}
            >
              <Star className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Remove this photo"
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </span>
      </figcaption>
    </figure>
  );
}

const STATUS_LABEL: Record<ListingImageView['status'], string> = {
  PENDING: 'Processing',
  READY: 'Ready',
  REJECTED: 'Not usable',
  FAILED: 'Failed',
};

/**
 * What a photo without servable bytes is doing, in the words its state calls
 * for.
 *
 * The PENDING case is deliberately the calm one — a spinner and "processing",
 * with no warning colour — because it is the good case and the most common.
 */
function StatusOverlay({ image }: { image: ListingImageView }) {
  if (image.status === 'PENDING') {
    return (
      <div
        className="flex size-full flex-col items-center justify-center gap-1.5 text-ink-soft"
        role="status"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <p className="text-data">Processing…</p>
      </div>
    );
  }

  const rejected = image.status === 'REJECTED';

  return (
    <div className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center">
      {rejected ? (
        <TriangleAlert className="size-4 text-clay" aria-hidden />
      ) : (
        <CircleAlert className="size-4 text-clay" aria-hidden />
      )}
      <p className="text-data text-clay">
        {image.failureReason ??
          (rejected ? 'That file is not a usable image' : 'We could not process that one')}
      </p>
      {rejected ? null : (
        <p className="text-data flex items-center gap-1 text-ink-faint">
          <RotateCcw className="size-3" aria-hidden />
          Remove it and try again
        </p>
      )}
    </div>
  );
}
