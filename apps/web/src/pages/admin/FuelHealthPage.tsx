import { FUEL_ADAPTER_DEAD_AFTER_RUNS } from '@machiya/shared';
import { motion, useReducedMotion } from 'motion/react';
import { CircleAlert, CircleCheck, CircleSlash, ExternalLink } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useFuelHealth } from '../../hooks/use-fuel-health';
import { formatRelative, humanizeSlug as cityName } from '../../lib/format';
import { cn } from '../../lib/utils';

/**
 * Per-adapter fuel scrape health.
 *
 * This page exists for one failure, and it is not "the scraper is down" —
 * that one is obvious, because prices stop. It is **one adapter dying quietly
 * while the others cover for it**: prices keep flowing, every listing page
 * looks right, and the redundancy that was the entire reason for having several
 * sources is gone without anyone noticing.
 *
 * So the layout leads with per-adapter state rather than with a green tick for
 * the pipeline as a whole.
 */
export function FuelHealthPage() {
  const reduced = useReducedMotion();

  const { report, isLoading, isMissing, isFailed, retry } = useFuelHealth();

  if (isLoading) {
    return <HealthSkeleton />;
  }

  if (isFailed) {
    return <LoadFailed what="the fuel price report" onRetry={retry} />;
  }

  if (isMissing || !report) {
    return (
      <EmptyState
        illustration="search"
        title="No fuel prices have been checked yet."
        detail="Nothing here does not mean everything is fine — it means no check has finished. The next one runs within the hour."
      />
    );
  }

  const dead = report.adapters.filter(
    (adapter) => adapter.consecutiveFailures >= FUEL_ADAPTER_DEAD_AFTER_RUNS,
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-title">Fuel prices</h2>
        <span className="text-data text-ink-faint">
          last checked {report.lastRunAt ? formatRelative(report.lastRunAt) : 'never'}
        </span>
      </header>

      {/* The two alarms, and they are different alarms. */}
      {report.citiesWithoutPrices.length > 0 ? (
        <p className="flex items-start gap-2 rounded-chrome border border-clay bg-clay-soft p-2.5 text-sm">
          <CircleAlert className="mt-px size-4 shrink-0 text-clay" aria-hidden />
          <span>
            No price at all for{' '}
            <strong>{report.citiesWithoutPrices.map(cityName).join(', ')}</strong>. Commute cost
            there falls back to the last stored row, and will go blank once nothing is stored.
          </span>
        </p>
      ) : null}

      {dead.length > 0 ? (
        <p className="flex items-start gap-2 rounded-chrome border border-clay bg-clay-soft p-2.5 text-sm">
          <CircleSlash className="mt-px size-4 shrink-0 text-clay" aria-hidden />
          <span>
            <strong>{dead.map((adapter) => adapter.label).join(', ')}</strong> has failed every run
            for at least {FUEL_ADAPTER_DEAD_AFTER_RUNS} hours. Prices are still flowing from the
            others, which is exactly why this needs saying out loud — the redundancy is gone.
          </span>
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {report.adapters.map((adapter, index) => {
          const isDead = adapter.consecutiveFailures >= FUEL_ADAPTER_DEAD_AFTER_RUNS;
          const isDegraded = adapter.consecutiveFailures > 0 && !isDead;
          const Icon = isDead ? CircleSlash : isDegraded ? CircleAlert : CircleCheck;

          return (
            <motion.li
              key={adapter.source}
              // Cards animate in on load, staggered, and never gate the content:
              // opacity and a few pixels of travel, both starting from visible
              // under reduced motion.
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduced ? { duration: 0 } : { duration: 0.25, delay: index * 0.05 }}
              className="rounded-chrome border border-edge bg-card p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <Icon
                    className={cn(
                      'mt-0.5 size-4 shrink-0',
                      isDead ? 'text-clay' : isDegraded ? 'text-signal-ink' : 'text-verdant',
                    )}
                    aria-hidden
                  />
                  <div>
                    <p className="text-sm font-medium">
                      {adapter.label}
                      <a
                        href={adapter.homepage}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="ml-1 inline-block align-middle text-ink-faint hover:text-ink-soft"
                      >
                        <ExternalLink className="size-3" aria-hidden />
                        <span className="sr-only">Open {adapter.label}</span>
                      </a>
                    </p>
                    <p className="text-data text-ink-faint">
                      {adapter.citiesOk.length > 0
                        ? `answered for ${adapter.citiesOk.map(cityName).join(', ')}`
                        : 'answered for no city'}
                    </p>
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  <p
                    className={cn(
                      'text-data tabular-nums',
                      adapter.consecutiveFailures > 0 ? 'text-clay' : 'text-ink-faint',
                    )}
                  >
                    {adapter.consecutiveFailures === 0
                      ? 'answering'
                      : `failed the last ${String(adapter.consecutiveFailures)} times`}
                  </p>
                  <p className="text-data text-ink-faint">
                    {adapter.lastSuccessAt
                      ? `last answered ${formatRelative(adapter.lastSuccessAt)}`
                      : 'has never answered'}
                  </p>
                </div>
              </div>

              {adapter.failures.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 border-t border-edge pt-2">
                  {adapter.failures.map((failure) => (
                    <li key={failure.citySlug} className="text-data text-ink-soft">
                      {/* The upstream's own error text stays in the log. */}
                      <span className="font-medium">{cityName(failure.citySlug)}</span> — could not
                      be read this time
                    </li>
                  ))}
                </ul>
              ) : null}
            </motion.li>
          );
        })}
      </ul>

      <p className="text-data text-ink-faint">
        Two of these three read the same upstream feed, so three answers are two opinions.
      </p>
    </div>
  );
}

/** Shaped like the adapter rows it replaces, not a sentence about loading. */
function HealthSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4" role="status">
      <span className="sr-only">Checking the latest fuel prices…</span>
      <div className="h-6 w-40 animate-pulse rounded-chrome bg-paper-sunken" />
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-16 animate-pulse rounded-chrome bg-paper-sunken" />
      ))}
    </div>
  );
}
