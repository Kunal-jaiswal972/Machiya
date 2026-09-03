import { motion, useReducedMotion, type PanInfo } from 'motion/react';
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { DESKTOP_QUERY, useMediaQuery } from '../../hooks/use-media-query';
import { useSearchUi } from '../../stores/search-ui';
import { cn } from '../../lib/utils';

/**
 * The shell the listing detail lives in.
 *
 * Desktop: springs in from the right, over the map. It is layered, not
 * navigated-away-to, and the spring says so.
 *
 * Mobile: a bottom sheet with drag-to-dismiss and **velocity-aware** snapping
 * between peek / half / full. Velocity matters: a short fast flick means "get
 * rid of this" and a long slow drag means "put it where I let go", and a
 * position-only threshold gets the first one wrong every time.
 *
 * Focus moves into the panel on open and returns to the invoking card on close
 * (the browser does the second half, because closing is a history navigation).
 */
export interface DetailPanelProps {
  onClose: () => void;
  children: ReactNode;
}

const SNAP_POINTS = { peek: 0.82, half: 0.42, full: 0.04 } as const;
type Snap = keyof typeof SNAP_POINTS;

export function DetailPanel({ onClose, children }: DetailPanelProps) {
  const reduced = useReducedMotion();
  // ONE of the two, never both. Rendering both and hiding one with `lg:hidden`
  // put the entire listing in the DOM twice — two landmarks, every control
  // duplicated, and a screen reader reading the price twice.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const sheet = useSearchUi((state) => state.sheet);
  const setSheet = useSearchUi((state) => state.setSheet);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus the panel itself rather than its first control: a screen reader then
  // announces the listing, and a keyboard user's next Tab lands on the close
  // button instead of skipping the price entirely.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const onDragEnd = (_event: unknown, info: PanInfo): void => {
    const flickDown = info.velocity.y > 600;
    const flickUp = info.velocity.y < -600;

    // A fast downward flick dismisses from any position, which is what the
    // gesture means — no distance threshold to argue with.
    if (flickDown && sheet !== 'full') {
      onClose();
      return;
    }

    if (flickUp) {
      setSheet(sheet === 'peek' ? 'half' : 'full');
      return;
    }

    // Otherwise snap to whichever point the release landed nearest.
    const height = window.innerHeight;
    const released = (info.point.y || 0) / height;
    const nearest = (Object.entries(SNAP_POINTS) as Array<[Snap, number]>).reduce((best, entry) =>
      Math.abs(entry[1] - released) < Math.abs(best[1] - released) ? entry : best,
    );

    if (nearest[0] === 'peek' && info.offset.y > 120) {
      onClose();
      return;
    }
    setSheet(nearest[0]);
  };

  if (isDesktop) {
    return (
      /* Desktop: a sidebar over the map. */
      <motion.aside
        ref={panelRef}
        tabIndex={-1}
        aria-label="Listing detail"
        initial={reduced ? false : { x: 32, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={reduced ? { opacity: 0 } : { x: 32, opacity: 0 }}
        transition={
          reduced ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 34, mass: 0.9 }
        }
        className="chrome absolute top-2 right-2 bottom-2 z-30 w-[420px] overflow-y-auto outline-none"
      >
        <CloseButton onClose={onClose} />
        {children}
      </motion.aside>
    );
  }

  return (
    /* Mobile: a bottom sheet. Only the top corners are rounded — the radius
       scale's one exception, because a sheet is hinged at the bottom. */
    <motion.div
      aria-label="Listing detail"
      drag={reduced ? false : 'y'}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.02, bottom: 0.4 }}
      onDragEnd={onDragEnd}
      initial={reduced ? false : { y: '100%' }}
      animate={{ y: `${String(SNAP_POINTS[sheet] * 100)}%` }}
      exit={reduced ? { opacity: 0 } : { y: '100%' }}
      transition={
        reduced ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 32, mass: 0.8 }
      }
      ref={panelRef}
      tabIndex={-1}
      className={cn(
        'chrome-over absolute inset-x-0 top-0 z-30 h-full overflow-y-auto rounded-t-sheet rounded-b-none outline-none',
        // Dragging must not fight the scroll: the sheet scrolls only once it
        // is at full height.
        sheet === 'full' ? 'touch-pan-y' : 'overflow-hidden touch-none',
      )}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between bg-card/95 px-3 py-2 backdrop-blur">
        {/* The grab handle is the affordance; it is also a button, so the
              gesture is not the only way to change the sheet's height. */}
        <button
          type="button"
          onClick={() => setSheet(sheet === 'full' ? 'half' : 'full')}
          className="mx-auto h-1 w-10 rounded-round bg-edge-strong"
        >
          <span className="sr-only">
            {sheet === 'full' ? 'Shrink this panel' : 'Expand this panel'}
          </span>
        </button>
        <CloseButton onClose={onClose} className="absolute top-1.5 right-2" />
      </div>
      {children}
    </motion.div>
  );
}

function CloseButton({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className={cn('chrome absolute top-2 right-2 z-10 grid size-8 place-items-center', className)}
    >
      <X className="size-4" aria-hidden />
      <span className="sr-only">Close this listing</span>
    </button>
  );
}
