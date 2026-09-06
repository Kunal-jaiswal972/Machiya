import {
  COMMUTE_MODES,
  FUEL_TYPE_LABELS,
  type CommuteMode,
  type CommutePreferences,
} from '@machiya/shared';
import { Bike, Bus, Car, Fuel, Info, TriangleAlert } from 'lucide-react';
import { useCountUp } from '../../hooks/use-count-up';
import type { ListingCommute } from '../../hooks/use-commute';
import { CommuteControls } from '../commute/CommuteControls';
import { formatDuration, formatRelative, formatRupees } from '../../lib/format';
import { cn } from '../../lib/utils';

/**
 * The commute, whole: how far, how long, what it costs, and against what.
 *
 * One block rather than two. The panel used to render "Commute from your
 * office" with its own car/bike toggle and then "Commute cost" with a second
 * one, so the same choice was offered twice and the two could disagree about
 * which mode you had picked (docs/ux-audit.md 1.11). Mode is chosen once here
 * and the map's route profile follows it.
 *
 * Everything is measured: a real road route from OSRM, a scraped fuel price
 * with its source, the city's own fares. Where a number is an estimate it says
 * so — the case for the feature collapses if an estimate reads as a measurement.
 */
const MODE_ICON: Record<CommuteMode, typeof Car> = { car: Car, bike: Bike, transit: Bus };
const MODE_LABEL: Record<CommuteMode, string> = {
  car: 'Car',
  bike: 'Bike',
  transit: 'Public transport',
};

export interface CommutePanelProps {
  commute: ListingCommute;
  preferences: CommutePreferences;
  onChange: (patch: Partial<CommutePreferences>) => void;
  /** False when signed out — the controls work, nothing is remembered. */
  isPersisted: boolean;
  /** For the fuel line, which is a price in a city rather than a price. */
  cityName: string;
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
  cityName,
  className,
}: CommutePanelProps) {
  const { selected, comparison, outlay, fuel, degraded } = commute;

  const priced = COMMUTE_MODES.map((mode) => ({ mode, cost: comparison[mode] })).filter(
    (entry): entry is { mode: CommuteMode; cost: NonNullable<typeof entry.cost> } =>
      entry.cost !== null && entry.cost.perMonth > 0,
  );

  // Cheapest first, and each row says what it costs against the one you have
  // chosen. The bars this replaces were scaled to the dearest mode, so the bike
  // — the option most likely to change the answer — rendered as a sliver next
  // to the car (docs/ux-audit.md 1.12). A difference in rupees per month is the
  // comparison; a length is a decoration of it.
  const ranked = [...priced].sort((a, b) => a.cost.perMonth - b.cost.perMonth);
  const cheapest = ranked[0];

  const reading = fuel?.prices.find((price) => price.fuelType === selected.fuelType);
  const fuelName = FUEL_TYPE_LABELS[selected.fuelType];

  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-title">Your commute</h3>
        <span className="text-data text-ink-faint">
          {selected.distanceKm} km by road
          {selected.durationMinutes > 0
            ? ` · ${formatDuration(selected.durationMinutes * 60)}`
            : ''}
        </span>
      </header>

      <div className="flex gap-1">
        {COMMUTE_MODES.map((mode) => {
          const Icon = MODE_ICON[mode];
          const isSelected = preferences.mode === mode;

          return (
            <button
              key={mode}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onChange({ mode })}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-chrome border px-2 py-1.5 text-label',
                isSelected
                  ? 'border-water bg-water-soft text-ink'
                  : 'border-edge text-ink-soft hover:text-ink',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {MODE_LABEL[mode]}
            </button>
          );
        })}
      </div>

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

      <ul className="flex flex-col divide-y divide-edge rounded-chrome border border-edge">
        {ranked.map(({ mode, cost }) => {
          const Icon = MODE_ICON[mode];
          const isSelected = mode === preferences.mode;
          const difference = cost.perMonth - selected.perMonth;

          return (
            <li key={mode}>
              <button
                type="button"
                onClick={() => onChange({ mode })}
                aria-pressed={isSelected}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-2 text-left',
                  isSelected ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <Icon
                  className={cn('size-4 shrink-0', isSelected ? 'text-water' : 'text-ink-faint')}
                  aria-hidden
                />
                <span className="w-10 shrink-0 text-label text-ink-soft">{MODE_LABEL[mode]}</span>

                <span className="flex-1 text-data text-ink-faint">
                  {isSelected
                    ? mode === cheapest?.mode
                      ? 'cheapest'
                      : `${formatRupees(Math.abs(selected.perMonth - (cheapest?.cost.perMonth ?? 0)))} more than ${MODE_LABEL[cheapest?.mode ?? 'bike'].toLowerCase()}`
                    : difference < 0
                      ? `${formatRupees(Math.abs(difference))} less a month`
                      : `${formatRupees(difference)} more a month`}
                </span>

                <span className="shrink-0 text-data tabular-nums text-ink">
                  {formatRupees(cost.perMonth)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Inputs. Every one of them moves the numbers above. */}
      <CommuteControls
        preferences={preferences}
        onChange={onChange}
        className="border-t border-edge pt-2.5"
      />

      {/* Provenance and honesty, in one quiet line each. */}
      <div className="flex flex-col gap-1 text-data text-ink-faint">
        {reading ? (
          <p className="flex items-start gap-1">
            <Fuel className="mt-px size-3 shrink-0" aria-hidden />
            <span>
              {fuelName} in {cityName} at {formatRupees(reading.price)}/litre, checked{' '}
              {formatRelative(fuel?.staleAt ?? reading.fetchedAt)}.{' '}
              <a
                href={reading.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline decoration-dotted underline-offset-2 hover:text-ink-soft"
              >
                {reading.sources.length > 1
                  ? `Checked against ${String(reading.sources.length)} price sources`
                  : 'Where this price comes from'}
              </a>
            </span>
          </p>
        ) : null}

        {degraded ? (
          <p className="flex items-start gap-1 text-clay">
            <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
            <span>
              No road route was available, so this is a straight-line estimate rather than a
              measured commute.
            </span>
          </p>
        ) : null}

        {!isPersisted ? (
          <p className="flex items-start gap-1">
            <Info className="mt-px size-3 shrink-0" aria-hidden />
            <span>These settings hold on this device. Sign in to keep them everywhere.</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
