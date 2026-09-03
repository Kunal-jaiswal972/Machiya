import { cn } from '../lib/utils';

/**
 * Skeletons match the SHAPE of what loads (docs/design.md).
 *
 * Not three grey bars. A result-card skeleton is a 4:3 photo band, a
 * price-width block, two meta lines and a 20px circle — because a skeleton that
 * does not match its content produces a visible jump when the real thing
 * arrives, which is worse than a spinner.
 */
function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-inset bg-paper-sunken',
        // The pulse is the only motion here, and reduced-motion kills it via the
        // global rule in index.css rather than a prop on every instance.
        className,
      )}
    />
  );
}

/** Matches ResultCard: photo band left, price and meta right, gauge bottom-right. */
export function ResultCardSkeleton() {
  return (
    <div className="flex gap-3 border-b border-edge p-3">
      <Shimmer className="aspect-4/3 w-28 shrink-0 rounded-chrome" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Shimmer className="h-7 w-32" />
        <Shimmer className="h-4 w-full max-w-48" />
        <Shimmer className="h-3 w-24" />
      </div>
      <Shimmer className="size-5 shrink-0 rounded-round" />
    </div>
  );
}

export function ResultListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <ResultCardSkeleton key={index} />
      ))}
    </div>
  );
}

/** Matches the detail panel: gallery, price row, gauge, facts grid. */
export function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4" aria-hidden>
      <Shimmer className="aspect-16/10 w-full rounded-chrome" />
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Shimmer className="h-10 w-40" />
          <Shimmer className="h-4 w-56" />
        </div>
        <Shimmer className="size-14 shrink-0 rounded-round" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Shimmer key={index} className="h-12" />
        ))}
      </div>
    </div>
  );
}

/** Matches a metric tile in the commute panel or the lister dashboard. */
export function MetricSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 rounded-chrome border border-edge p-3" aria-hidden>
      <Shimmer className="h-3 w-16" />
      <Shimmer className="h-6 w-24" />
    </div>
  );
}
