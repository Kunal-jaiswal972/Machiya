import { FUEL_ADAPTER_DEAD_AFTER_RUNS } from '@machiya/shared';
import { motion, useReducedMotion } from 'motion/react';
import { CircleAlert, CircleCheck, CircleSlash, ExternalLink } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { useFuelHealth } from '../../hooks/use-fuel-health';
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

  const { report, isLoading, isMissing } = useFuelHealth();

  if (isLoading) {
    return <p className="p-6 text-sm text-ink-soft">Reading the last scrape…</p>;
  }

  if (isMissing || !report) {
    return (
      <EmptyState
        illustration="search"
        title="No scrape has been recorded."
        detail="The health report is written without an expiry, so nothing here means the worker has not completed a fuel scrape since this Redis was last cleared — not that everything is fine."
      />
    );
  }

  const dead = report.adapters.filter(
    (adapter) => adapter.consecutiveFailures >= FUEL_ADAPTER_DEAD_AFTER_RUNS,
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-title">Fuel scrape health</h1>
        <span className="text-data text-ink-faint">
          last run {new Date(report.lastRunAt ?? 0).toLocaleString()}
        </span>
      </header>

      {/* The two alarms, and they are different alarms. */}
      {report.citiesWithoutPrices.length > 0 ? (
        <p className="flex items-start gap-2 rounded-chrome border border-clay bg-clay-soft p-2.5 text-sm">
          <CircleAlert className="mt-px size-4 shrink-0 text-clay" aria-hidden />
          <span>
            No price at all for <strong>{report.citiesWithoutPrices.join(', ')}</strong>. Commute
            cost there falls back to the last stored row, and will go blank once nothing is stored.
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
                        ? `answered for ${adapter.citiesOk.join(', ')}`
                        : 'answered for no city'}
                      {' · '}
                      {adapter.averageDurationMs} ms average
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
                      ? 'healthy'
                      : `${String(adapter.consecutiveFailures)} runs failing`}
                  </p>
                  <p className="text-data text-ink-faint">
                    {adapter.lastSuccessAt
                      ? `ok ${new Date(adapter.lastSuccessAt).toLocaleTimeString()}`
                      : 'never succeeded'}
                  </p>
                </div>
              </div>

              {adapter.failures.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 border-t border-edge pt-2">
                  {adapter.failures.map((failure) => (
                    <li key={failure.citySlug} className="text-data text-ink-soft">
                      <span className="font-medium">{failure.citySlug}</span> — {failure.error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </motion.li>
          );
        })}
      </ul>

      <p className="text-data text-ink-faint">
        Several sources per fuel type exist so one can fail without the price disappearing. Two of
        them share an upstream feed and return identical figures, so three adapters answering is two
        independent opinions, not three — see DECISIONS.md D62.
      </p>
    </div>
  );
}
