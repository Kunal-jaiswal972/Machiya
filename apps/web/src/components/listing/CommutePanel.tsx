import { COMMUTE_MODES, type CommuteMode, type CommutePreferences } from '@machiya/shared';
import { motion, useReducedMotion } from 'motion/react';
import { Bike, Bus, Car, Fuel, Info } from 'lucide-react';
import { useCountUp } from '../../hooks/use-count-up';
import { CommuteControls } from '../commute/CommuteControls';
import type { ListingCommute } from '../../hooks/use-commute';
import { formatRupees } from '../../lib/format';
import { cn } from '../../lib/utils';

/**
 * Commute cost, and the argument the product is built on.
 *
 * Everything here is measured: the distance is a real road route from OSRM, the
 * fuel price is scraped and attributed, and the fares are the city's own. Where
 * a number is an estimate it says so — the whole case for the feature collapses
 * if an estimate is presented as a measurement.
 */
const MODE_ICON: Record<CommuteMode, typeof Car> = { car: Car, bike: Bike, transit: Bus };
const MODE_LABEL: Record<CommuteMode, string> = { car: 'Car', bike: 'Bike', transit: 'Bus' };

export interface CommutePanelProps {
  commute: ListingCommute;
  preferences: CommutePreferences;
  onChange: (patch: Partial<CommutePreferences>) => void;
  /** False when signed out — the controls work, nothing is remembered. */
  isPersisted: boolean;
  className?: string;
}

/** A rupee figure that counts to its new value when an input changes. */
function Rupees({ value, className }: { value: number; className?: string }) {
  const animated = useCountUp(value);
  // `tabular-nums` so the digits do not jitter horizontally while counting,
  // which is what makes a counting number feel broken rather than alive.
  return <span className={cn('tabular-nums', className)}>{formatRupees(animated)}</span>;
}

export function CommutePanel({
  commute,
  preferences,
  onChange,
  isPersisted,
  className,
}: CommutePanelProps) {
  const reduced = useReducedMotion();

  const { selected, comparison, outlay, fuel, degraded } = commute;

  const priced = COMMUTE_MODES.map((mode) => ({ mode, cost: comparison[mode] })).filter(
    (entry): entry is { mode: CommuteMode; cost: NonNullable<typeof entry.cost> } =>
      entry.cost !== null && entry.cost.perMonth > 0,
  );
  const worst = Math.max(...priced.map((entry) => entry.cost.perMonth), 1);

  return (
    <section className={cn('flex flex-col gap-3 border-t border-edge p-3', className)}>
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-title">Commute cost</h3>
        <span className="text-data text-ink-faint">
          {selected.distanceKm} km by road
          {selected.durationMinutes > 0 ? ` · ${String(selected.durationMinutes)} min` : ''}
        </span>
      </header>

      {/* The two numbers the brief asks for first, largest. */}
      <div className="flex items-end gap-5">
        <div>
          <Rupees
            value={selected.perMonth}
            className="text-price-xl text-signal-ink dark:text-signal"
          />
          <p className="text-label text-ink-faint">per month</p>
        </div>
        <div>
          <Rupees value={selected.perTrip} className="text-price-lg text-ink-soft" />
          <p className="text-label text-ink-faint">per trip</p>
        </div>
      </div>

      {/*
        Total true monthly cost — the product's argument, and the second-loudest
        thing on the panel because it is the number that should decide.
      */}
      {outlay.total !== null ? (
        <div className="rounded-chrome bg-paper-sunken p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-label text-ink-soft">Rent + maintenance + commute</span>
            <Rupees value={outlay.total} className="text-price-lg text-ink" />
          </div>
          <p className="mt-0.5 text-data text-ink-faint">
            {formatRupees(outlay.rent)} rent
            {outlay.maintenance > 0
              ? ` · ${formatRupees(outlay.maintenance)} maintenance`
              : ''} · {formatRupees(outlay.commute)} commute
            {outlay.commuteShareOfRent !== null
              ? ` — commute is ${String(outlay.commuteShareOfRent)}% of rent`
              : ''}
          </p>
        </div>
      ) : (
        <p className="text-data text-ink-faint">
          This is a sale listing, so there is no monthly total to compare — the commute cost stands
          on its own.
        </p>
      )}

      {/* Bike vs car vs transit. Bars animate their width; the labels do not
          move, so the comparison stays readable mid-animation. */}
      <div className="flex flex-col gap-1.5">
        {priced.map(({ mode, cost }) => {
          const Icon = MODE_ICON[mode];
          const share = (cost.perMonth / worst) * 100;
          const isSelected = mode === preferences.mode;

          return (
            <button
              key={mode}
              type="button"
              onClick={() => onChange({ mode })}
              aria-pressed={isSelected}
              className={cn(
                'group flex items-center gap-2 rounded-inset px-1.5 py-1 text-left',
                isSelected ? 'bg-accent' : 'hover:bg-accent/60',
              )}
            >
              <Icon
                className={cn('size-4 shrink-0', isSelected ? 'text-water' : 'text-ink-faint')}
                aria-hidden
              />
              <span className="w-10 shrink-0 text-label text-ink-soft">{MODE_LABEL[mode]}</span>

              <span className="relative h-2 flex-1 overflow-hidden rounded-round bg-paper-sunken">
                <motion.span
                  className={cn(
                    'absolute inset-y-0 left-0 rounded-round',
                    isSelected ? 'bg-water' : 'bg-edge-strong',
                  )}
                  initial={reduced ? false : { width: 0 }}
                  animate={{ width: `${String(share)}%` }}
                  transition={reduced ? { duration: 0 } : { duration: 0.45, ease: 'easeOut' }}
                />
              </span>

              <span className="w-20 shrink-0 text-right text-data tabular-nums">
                {formatRupees(cost.perMonth)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Inputs. Every one of them moves the numbers above. */}
      <CommuteControls
        preferences={preferences}
        onChange={onChange}
        className="border-t border-edge pt-2.5"
      />

      {/* Provenance and honesty, in one quiet line each. */}
      <div className="flex flex-col gap-1 text-data text-ink-faint">
        {fuel ? (
          <p className="flex items-start gap-1">
            <Fuel className="mt-px size-3 shrink-0" aria-hidden />
            <span>
              {selected.fuelType.charAt(0) + selected.fuelType.slice(1).toLowerCase()} at{' '}
              {formatRupees(fuel.prices.find((p) => p.fuelType === selected.fuelType)?.price ?? 0)}
              /litre, from{' '}
              <a
                href={fuel.prices.find((p) => p.fuelType === selected.fuelType)?.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline decoration-dotted underline-offset-2 hover:text-ink-soft"
              >
                {fuel.prices.find((p) => p.fuelType === selected.fuelType)?.source}
              </a>
              {fuel.staleAt ? (
                <> — last checked {new Date(fuel.staleAt).toLocaleString()}, refreshing now</>
              ) : null}
            </span>
          </p>
        ) : null}

        {degraded ? (
          <p className="flex items-start gap-1 text-clay">
            <Info className="mt-px size-3 shrink-0" aria-hidden />
            <span>
              No road route was available, so this is a straight-line estimate rather than a
              measured commute.
            </span>
          </p>
        ) : null}

        {!isPersisted ? <p>Sign in to keep these settings between visits.</p> : null}
      </div>
    </section>
  );
}
