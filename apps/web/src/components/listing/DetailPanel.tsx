import { motion, useReducedMotion, type PanInfo } from 'motion/react';
import { Maximize2, Minimize2, X } from 'lucide-react';
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
 * Focus moves into the panel on open and back to whatever opened it on close.
 * The mobile sheet covers the page, so it also traps Tab; the desktop panel
 * deliberately does not, because the map behind it stays live and reaching the
 * search field without closing the panel is the point (D78).
 */
export interface DetailPanelProps {
  onClose: () => void;
  /**
   * Full-screen reading, driven by the `full` child route (D82). Modal at every
   * width — there is nothing behind it to press — so it traps focus and dims
   * what it covers.
   */
  expanded?: boolean;
  /** Toggles into and out of `expanded`; both directions are a navigation. */
  onToggleExpanded?: () => void;
  children: ReactNode;
}

const SNAP_POINTS = { peek: 0.82, half: 0.42, full: 0.04 } as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
type Snap = keyof typeof SNAP_POINTS;

export function DetailPanel({
  onClose,
  expanded = false,
  onToggleExpanded,
  children,
}: DetailPanelProps) {
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
  // button instead of skipping the price entirely. On the way out, focus goes
  // back to the card that opened it — the list stays mounted behind the panel,
  // so that element is usually still there to receive it.
  useEffect(() => {
    const trigger = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });

    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  // Full screen scrolls itself, so the page behind it must not: two scrollbars
  // side by side is the tell that an overlay forgot to say it was one.
  useEffect(() => {
    if (!expanded) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [expanded]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      // Modal surfaces trap Tab: the sheet and the expanded view both cover
      // the page, so wrapping keeps focus where the eye is (docs/ux-audit.md
      // 1.8). The desktop sidebar deliberately does not — D78.
      if (event.key !== 'Tab' || (isDesktop && !expanded)) return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === panel,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, isDesktop, expanded]);

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

  if (expanded) {
    return (
      /* Full screen: the same panel, read like a page. Above the app header on
         purpose — the point is the photographs and the facts, without the map
         taking two thirds of the width. */
      <motion.div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Listing detail"
        initial={reduced ? false : { opacity: 0, scale: 0.99 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.99 }}
        transition={reduced ? { duration: 0 } : { duration: 0.18, ease: 'easeOut' }}
        className="fixed inset-0 z-50 overflow-y-auto bg-paper outline-none"
      >
        <div className="mx-auto max-w-3xl">{children}</div>
        <CloseButton onClose={onClose} className="fixed top-3 right-3" />
        {onToggleExpanded ? (
          <ExpandButton expanded onToggle={onToggleExpanded} className="fixed top-3 right-14" />
        ) : null}
      </motion.div>
    );
  }

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
        {onToggleExpanded ? (
          <ExpandButton expanded={false} onToggle={onToggleExpanded} className="top-2 right-12" />
        ) : null}
        {children}
      </motion.aside>
    );
  }

  return (
    <>
      {/* Pressing the map above the sheet dismisses it. Desktop has no scrim:
          the map there is live, and a press on it closes the panel through the
          map's own click handler instead. */}
      <motion.button
        type="button"
        onClick={onClose}
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={reduced ? { duration: 0 } : { duration: 0.2 }}
        className="absolute inset-0 z-20 bg-scrim"
        tabIndex={-1}
        aria-hidden
      />
      {/* Mobile: a bottom sheet. Only the top corners are rounded — the radius
       scale's one exception, because a sheet is hinged at the bottom. */}
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
          {onToggleExpanded ? (
            <ExpandButton
              expanded={false}
              onToggle={onToggleExpanded}
              className="absolute top-1.5 right-11"
            />
          ) : null}
          <CloseButton onClose={onClose} className="absolute top-1.5 right-2" />
        </div>
        {children}
      </motion.div>
    </>
  );
}

function ExpandButton({
  expanded,
  onToggle,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = expanded ? Minimize2 : Maximize2;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn('chrome absolute z-10 grid size-8 place-items-center', className)}
    >
      <Icon className="size-4" aria-hidden />
      <span className="sr-only">{expanded ? 'Back to the map' : 'Open full screen'}</span>
    </button>
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
