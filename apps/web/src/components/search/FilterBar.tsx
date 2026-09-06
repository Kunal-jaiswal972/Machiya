import {
  FURNISHING_TYPES,
  PROPERTY_TYPES,
  RING_RADII_METERS,
  type SearchQuery,
} from '@machiya/shared';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import { formatDistance, formatRupees, humanizeEnum } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { RingGauge } from '../RingGauge';

/**
 * Filter chips, the sort control and the ring picker.
 *
 * Chips animate their layout with a shared `layoutId`, so adding or removing
 * one reads as a reorder rather than a flash (docs/design.md). The full filter
 * set lives behind one button: a permanently-expanded filter panel on a map
 * page spends the screen the map needs.
 */
export interface FilterBarProps {
  query: SearchQuery;
  radiusMeters: number;
  ringCounts: Record<1 | 2 | 3, number>;
  total: number;
  activeFilterCount: number;
  update: (patch: Partial<SearchQuery>) => void;
  clearFilters: () => void;
}

interface ActiveChip {
  key: string;
  label: string;
  clear: Partial<SearchQuery>;
}

function activeChips(query: SearchQuery): ActiveChip[] {
  const chips: ActiveChip[] = [];

  if (query.type) {
    chips.push({
      key: 'type',
      label: query.type === 'RENT' ? 'For rent' : 'For sale',
      clear: { type: undefined },
    });
  }

  if (query.priceMin !== undefined || query.priceMax !== undefined) {
    const min = query.priceMin === undefined ? null : formatRupees(query.priceMin);
    const max = query.priceMax === undefined ? null : formatRupees(query.priceMax);
    chips.push({
      key: 'price',
      label: min && max ? `${min}–${max}` : min ? `over ${min}` : `under ${String(max)}`,
      clear: { priceMin: undefined, priceMax: undefined },
    });
  }

  if (query.bedsMin !== undefined || query.bedsMax !== undefined) {
    chips.push({
      key: 'beds',
      label:
        query.bedsMin !== undefined && query.bedsMax !== undefined
          ? `${String(query.bedsMin)}–${String(query.bedsMax)} BHK`
          : query.bedsMin !== undefined
            ? `${String(query.bedsMin)}+ BHK`
            : `up to ${String(query.bedsMax)} BHK`,
      clear: { bedsMin: undefined, bedsMax: undefined },
    });
  }

  if (query.property) {
    chips.push({
      key: 'property',
      label:
        query.property.length === 1
          ? humanizeEnum(query.property[0] ?? '')
          : `${String(query.property.length)} property types`,
      clear: { property: undefined },
    });
  }

  if (query.furnishing) {
    chips.push({
      key: 'furnishing',
      label:
        query.furnishing.length === 1
          ? humanizeEnum(query.furnishing[0] ?? '')
          : `${String(query.furnishing.length)} furnishing types`,
      clear: { furnishing: undefined },
    });
  }

  if (query.bathsMin !== undefined) {
    chips.push({
      key: 'baths',
      label: `${String(query.bathsMin)}+ bath`,
      clear: { bathsMin: undefined },
    });
  }

  if (query.areaMin !== undefined || query.areaMax !== undefined) {
    chips.push({
      key: 'area',
      label:
        query.areaMin !== undefined
          ? `${String(query.areaMin)}+ sq ft`
          : `under ${String(query.areaMax)} sq ft`,
      clear: { areaMin: undefined, areaMax: undefined },
    });
  }

  if (query.verified) {
    chips.push({ key: 'verified', label: 'Verified only', clear: { verified: undefined } });
  }

  if (query.q) {
    chips.push({ key: 'q', label: `“${query.q}”`, clear: { q: undefined } });
  }

  return chips;
}

/**
 * `Total monthly cost` is listed first: it is what the product exists to rank
 * by, and burying it under `Nearest` would make the differentiator the option
 * nobody finds.
 */
const SORTS: Array<{ value: NonNullable<SearchQuery['sort']>; label: string }> = [
  { value: 'total_cost', label: 'Total monthly cost' },
  { value: 'distance', label: 'Nearest' },
  { value: 'price_asc', label: 'Cheapest' },
  { value: 'price_desc', label: 'Dearest' },
  { value: 'newest', label: 'Newest' },
];

export function FilterBar({
  query,
  radiusMeters,
  ringCounts,
  total,
  activeFilterCount,
  update,
  clearFilters,
}: FilterBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const reduced = useReducedMotion();
  const chips = activeChips(query);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {/* Ring picker. Doubles as the counts display: choosing a ring shows
            what it contains before you commit to it. */}
        <div
          className="flex items-center gap-1 rounded-chrome border border-edge p-0.5"
          data-tour="ring-counts"
        >
          {([1, 2, 3] as const).map((ring) => {
            const active = query.ring === ring;
            const enabled = (RING_RADII_METERS[ring - 1] ?? 0) <= radiusMeters;

            return (
              <button
                key={ring}
                type="button"
                disabled={!enabled}
                onClick={() => update({ ring: active ? undefined : ring })}
                aria-pressed={active}
                className={cn(
                  'flex items-center gap-1.5 rounded-inset px-2 py-1 text-label transition-colors disabled:opacity-40',
                  active ? 'bg-signal text-signal-ink' : 'hover:bg-accent',
                )}
              >
                <span className="text-data">{String(ring)} km</span>
                <span className={cn('text-data', active ? '' : 'text-ink-faint')}>
                  {String(ringCounts[ring])}
                </span>
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-2 rounded-chrome border border-edge px-2 py-1">
          <span className="sr-only">Search radius</span>
          <input
            type="range"
            min={500}
            max={3000}
            step={500}
            value={radiusMeters}
            onChange={(event) => {
              const next = Number(event.target.value);
              update({
                radius: next,
                // A ring outside the new radius would filter to nothing.
                ...(query.ring && (RING_RADII_METERS[query.ring - 1] ?? 0) > next
                  ? { ring: undefined }
                  : {}),
              });
            }}
            className="w-24 accent-[var(--color-water)]"
          />
          <span className="text-data w-12 text-ink-soft">{formatDistance(radiusMeters)}</span>
        </label>

        <Button
          variant={activeFilterCount > 0 ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSheetOpen((open) => !open)}
        >
          <SlidersHorizontal aria-hidden />
          Filters
          {activeFilterCount > 0 ? (
            <span className="text-data">{String(activeFilterCount)}</span>
          ) : null}
        </Button>

        <label className="ml-auto flex items-center gap-1.5" data-tour="sort">
          <span className="text-label text-ink-soft">Sort</span>
          <select
            value={query.sort ?? 'distance'}
            onChange={(event) =>
              update({ sort: event.target.value as NonNullable<SearchQuery['sort']> })
            }
            className="h-8 rounded-chrome border border-input bg-card px-2 text-label"
          >
            {SORTS.map((sort) => (
              <option key={sort.value} value={sort.value}>
                {sort.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <AnimatePresence mode="popLayout" initial={false}>
            {chips.map((chip) => (
              <motion.button
                key={chip.key}
                layoutId={reduced ? undefined : `chip-${chip.key}`}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 500, damping: 34 }}
                type="button"
                onClick={() => update(chip.clear)}
                className="flex items-center gap-1 rounded-inset border border-edge bg-paper-sunken px-2 py-0.5 text-label hover:border-edge-strong"
              >
                {chip.label}
                <X className="size-3 text-ink-faint" aria-hidden />
                <span className="sr-only">Remove this filter</span>
              </motion.button>
            ))}
          </AnimatePresence>

          <button
            type="button"
            onClick={clearFilters}
            className="text-label text-ink-faint underline-offset-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}

      <AnimatePresence>
        {sheetOpen ? (
          <motion.div
            initial={reduced ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduced ? { opacity: 1 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="grid gap-3 rounded-chrome border border-edge p-3 sm:grid-cols-2">
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-label text-ink-soft">Rent or buy</legend>
                <div className="flex gap-1">
                  {(['RENT', 'SALE'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => update({ type: query.type === type ? undefined : type })}
                      aria-pressed={query.type === type}
                      className={cn(
                        'rounded-inset border border-edge px-2 py-1 text-label',
                        query.type === type ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      {type === 'RENT' ? 'For rent' : 'For sale'}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-label text-ink-soft">
                  {query.type === 'SALE' ? 'Price (₹)' : 'Monthly rent (₹)'}
                </legend>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    inputMode="numeric"
                    placeholder="No less than"
                    value={query.priceMin ?? ''}
                    onChange={(event) =>
                      update({
                        priceMin:
                          event.target.value === '' ? undefined : Number(event.target.value),
                      })
                    }
                    className="h-8 w-24 rounded-inset border border-input bg-card px-2 text-data"
                  />
                  <span className="text-ink-faint">–</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    placeholder="No more than"
                    value={query.priceMax ?? ''}
                    onChange={(event) =>
                      update({
                        priceMax:
                          event.target.value === '' ? undefined : Number(event.target.value),
                      })
                    }
                    className="h-8 w-24 rounded-inset border border-input bg-card px-2 text-data"
                  />
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-label text-ink-soft">Bedrooms</legend>
                <div className="flex gap-1">
                  {[1, 2, 3, 4].map((beds) => (
                    <button
                      key={beds}
                      type="button"
                      onClick={() => update({ bedsMin: query.bedsMin === beds ? undefined : beds })}
                      aria-pressed={query.bedsMin === beds}
                      className={cn(
                        'rounded-inset border border-edge px-2 py-1 text-data',
                        query.bedsMin === beds ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      {String(beds)}+
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-label text-ink-soft">Bathrooms</legend>
                <div className="flex gap-1">
                  {[1, 2, 3].map((baths) => (
                    <button
                      key={baths}
                      type="button"
                      onClick={() =>
                        update({ bathsMin: query.bathsMin === baths ? undefined : baths })
                      }
                      aria-pressed={query.bathsMin === baths}
                      className={cn(
                        'rounded-inset border border-edge px-2 py-1 text-data',
                        query.bathsMin === baths ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      {String(baths)}+
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
                <legend className="text-label text-ink-soft">Property type</legend>
                <div className="flex flex-wrap gap-1">
                  {PROPERTY_TYPES.map((type) => {
                    const selected = query.property?.includes(type) ?? false;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          const current: (typeof type)[] = query.property ?? [];
                          const next = selected
                            ? current.filter((value) => value !== type)
                            : [...current, type];
                          // The schema types this as a non-empty tuple, so an
                          // emptied selection clears the filter rather than
                          // sending an empty array that would match nothing.
                          const [head, ...rest] = next;
                          update({ property: head ? [head, ...rest] : undefined });
                        }}
                        aria-pressed={selected}
                        className={cn(
                          'rounded-inset border border-edge px-2 py-1 text-label',
                          selected ? 'bg-accent' : 'hover:bg-accent/60',
                        )}
                      >
                        {humanizeEnum(type)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
                <legend className="text-label text-ink-soft">Furnishing</legend>
                <div className="flex flex-wrap gap-1">
                  {FURNISHING_TYPES.map((type) => {
                    const selected = query.furnishing?.includes(type) ?? false;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          const current: (typeof type)[] = query.furnishing ?? [];
                          const next = selected
                            ? current.filter((value) => value !== type)
                            : [...current, type];
                          const [head, ...rest] = next;
                          update({ furnishing: head ? [head, ...rest] : undefined });
                        }}
                        aria-pressed={selected}
                        className={cn(
                          'rounded-inset border border-edge px-2 py-1 text-label',
                          selected ? 'bg-accent' : 'hover:bg-accent/60',
                        )}
                      >
                        {humanizeEnum(type)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <label className="flex items-center gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={query.verified ?? false}
                  onChange={(event) =>
                    update({ verified: event.target.checked ? true : undefined })
                  }
                  className="accent-[var(--color-verdant)]"
                />
                <span className="text-label">Verified listings only</span>
              </label>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Announced once per change, debounced by the query itself settling. */}
      <p aria-live="polite" className="text-data text-ink-soft">
        <RingGauge
          ring={query.ring ?? 3}
          distanceMeters={radiusMeters}
          size={20}
          className="mr-1.5 inline-block align-text-bottom"
        />
        {total === 0
          ? `Nothing within ${formatDistance(radiusMeters)} yet`
          : `${String(total)} within ${formatDistance(radiusMeters)}`}
      </p>
    </div>
  );
}
