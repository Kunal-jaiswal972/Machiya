import type { ListingCard } from '@machiya/shared';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { EmptyState } from '../EmptyState';
import { ResultListSkeleton } from '../Skeletons';
import { Button } from '../ui/button';
import { ResultCard } from './ResultCard';

/**
 * The result list, and the canonical representation of a search.
 *
 * The map is `aria-hidden` and its markers are exposed through this list
 * instead: one canonical representation, and the accessible one is not the
 * degraded one (docs/design.md).
 *
 * The next page loads on an IntersectionObserver rather than a button, but the
 * button is still there — an observer that misfires with a keyboard-only user
 * scrolling by page would otherwise strand them at 24 results.
 */
export interface ResultListProps {
  listings: ListingCard[];
  total: number;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  searchSuffix: string;
  hasFilters: boolean;
  onClearFilters: () => void;
  favoriteIds?: Set<string>;
  onToggleFavorite?: (listingId: string) => void;
}

export function ResultList({
  listings,
  total,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
  searchSuffix,
  hasFilters,
  onClearFilters,
  favoriteIds,
  onToggleFavorite,
}: ResultListProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) fetchNextPage();
      },
      // Start the next page before the user reaches the bottom, so the list
      // does not visibly stall.
      { rootMargin: '400px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, fetchNextPage]);

  if (isLoading) {
    return <ResultListSkeleton />;
  }

  if (listings.length === 0) {
    return hasFilters ? (
      <EmptyState
        illustration="rings"
        title="Nothing inside this radius with these filters."
        detail="The rings show where you searched. Clearing the filters usually brings back a dozen."
        action={
          <Button onClick={onClearFilters} size="sm">
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        illustration="rings"
        title="No listings inside this radius yet."
        detail="Try a different office, or widen the radius to 3 km."
      />
    );
  }

  return (
    <div>
      {/*
        A re-sort ANIMATES as a reorder rather than repainting in place. That is
        the point of the total-cost sort: watching a cheap flat far out sink past
        a pricier one nearby is what makes the inversion legible.

        `layout="position"` and a stable `layoutId` per listing let motion
        interpolate the positions instead of swapping the DOM. Position only —
        no width or height — so sixty cards reshuffling stays a transform on the
        compositor rather than sixty layout passes.
      */}
      {listings.map((listing) => (
        <motion.div
          key={listing.id}
          layoutId={`result-${listing.id}`}
          layout={reduced ? false : 'position'}
          transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 34 }}
        >
          <ResultCard
            listing={listing}
            searchSuffix={searchSuffix}
            isFavorite={favoriteIds?.has(listing.id) ?? false}
            {...(onToggleFavorite ? { onToggleFavorite } : {})}
          />
        </motion.div>
      ))}

      <div ref={sentinel} aria-hidden className="h-px" />

      <div className="flex flex-col items-center gap-2 p-4">
        {isFetchingNextPage ? <ResultListSkeleton rows={2} /> : null}
        {hasNextPage && !isFetchingNextPage ? (
          <Button variant="outline" size="sm" onClick={fetchNextPage}>
            Show more
          </Button>
        ) : null}
        {!hasNextPage ? (
          <p className="text-data text-ink-faint">
            {total === listings.length
              ? `All ${String(total)} shown`
              : `${String(listings.length)} of ${String(total)} shown`}
          </p>
        ) : null}
      </div>
    </div>
  );
}
