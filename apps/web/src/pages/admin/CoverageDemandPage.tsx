import { MapPin } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { useCoverageDemand } from '../../hooks/use-admin';

/**
 * Where people are asking the product to go next — the point of D55's table.
 *
 * Ranked by **distinct people**, not by rows and not by asks. Two people asking
 * about Mumbai will not have dropped pins on the same building, so the grouping
 * is spatial at the same radius the public endpoint reports back; and a ranking
 * by taps would let one determined person choose the fourth city.
 *
 * The distinction is stated on the page rather than left to the column header,
 * because "40 requests" and "40 people" are the same number for very different
 * reasons and only one of them is a reason to build a city.
 */
export function CoverageDemandPage() {
  const demand = useCoverageDemand();

  if (demand.isPending) return <DemandSkeleton />;

  const clusters = demand.data?.clusters ?? [];

  if (clusters.length === 0) {
    return (
      <EmptyState
        illustration="rings"
        title="Nobody has asked for a new city yet"
        detail="When someone drops a pin outside the served area and leaves an email, it lands here — clustered, so nearby requests count as one place."
      />
    );
  }

  const radiusKm = Math.round((demand.data?.clusterRadiusMeters ?? 50_000) / 1000);

  return (
    <>
      <p className="text-data text-ink-soft">
        Requests within {radiusKm} km of each other are one place. Ranked by distinct people,
        because a count of taps would let one person pick the next city.
      </p>

      <ol className="grid gap-2">
        {clusters.map((cluster, index) => (
          <li
            key={`${String(cluster.lat)},${String(cluster.lng)}`}
            className="chrome flex flex-wrap items-center gap-3 p-3"
          >
            <span className="text-price-lg w-8 shrink-0 text-ink-faint tabular-nums">
              {index + 1}
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-label truncate">{cluster.label ?? 'An unnamed point'}</p>
              <p className="text-data flex items-center gap-1 text-ink-soft">
                <MapPin className="size-3 shrink-0" aria-hidden />
                {cluster.lat.toFixed(3)}, {cluster.lng.toFixed(3)}
              </p>
              <p className="text-data text-ink-faint">
                first asked {new Date(cluster.firstAskedAt).toLocaleDateString('en-IN')} · last{' '}
                {new Date(cluster.lastAskedAt).toLocaleDateString('en-IN')}
              </p>
            </div>

            <div className="flex shrink-0 gap-4 text-right">
              <div>
                <p className="text-price-lg text-signal-ink dark:text-signal">{cluster.people}</p>
                <p className="text-data text-ink-faint">people</p>
              </div>
              <div>
                <p className="text-price-lg text-ink-soft">{cluster.asks}</p>
                <p className="text-data text-ink-faint">asks</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function DemandSkeleton() {
  return (
    <ul className="grid gap-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <li key={row} className="chrome flex items-center gap-3 p-3">
          <div className="size-8 shrink-0 animate-pulse rounded-full bg-paper-sunken" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-1/3 animate-pulse rounded-full bg-paper-sunken" />
            <div className="h-3 w-1/4 animate-pulse rounded-full bg-paper-sunken" />
          </div>
          <div className="h-8 w-16 animate-pulse rounded-full bg-paper-sunken" />
        </li>
      ))}
      <li className="sr-only" role="status">
        Loading coverage requests…
      </li>
    </ul>
  );
}
