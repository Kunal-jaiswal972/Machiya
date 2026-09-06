import { coverageMessage, type GeocodeResult, type OutOfCoverage } from '@machiya/shared';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Building2, Crosshair, Loader2, MapPin, Search, Star } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { usePlaceSuggestions } from '../../hooks/use-place-suggestions';
import { cn } from '../../lib/utils';
import type { Office } from '@machiya/shared';

/**
 * Office selection: the product's first interaction.
 *
 * A combobox over the two-tier autocomplete (docs/geo.md). Built by hand rather
 * than with a headless library because the keyboard contract here is small and
 * specific — ArrowUp/Down move an *active* option without moving focus out of
 * the input, Enter commits, Escape closes — and a generic combobox brings a
 * roving-focus model that fights the map behind it.
 *
 * ARIA: `combobox` + `listbox`, `aria-activedescendant` for the active row.
 * Focus never leaves the input, which is what lets someone type, arrow and
 * commit without their hand leaving the keyboard.
 */
export interface OfficeFieldProps {
  /** The address currently shown, or empty when no office is set. */
  value: string;
  onSelect: (result: GeocodeResult) => void;
  /** Saved offices, shown before the user types anything. */
  savedOffices?: Office[];
  onSelectSaved?: (office: Office) => void;
  onUseMyLocation?: () => void;
  isLocating?: boolean;
  citySlug?: string;
  /**
   * Jump to a covered city from the out-of-coverage message. Optional so the
   * field still works where there is nowhere to jump to.
   */
  onPickCity?: (city: OutOfCoverage['supportedCities'][number]) => void;
  className?: string;
}

const KIND_ICON: Record<GeocodeResult['kind'], typeof MapPin> = {
  city: Building2,
  locality: MapPin,
  listing: MapPin,
  address: MapPin,
  poi: MapPin,
};

export function OfficeField({
  value,
  onSelect,
  savedOffices = [],
  onSelectSaved,
  onUseMyLocation,
  isLocating = false,
  citySlug,
  onPickCity,
  className,
}: OfficeFieldProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * The one-line hint under the field, shown on FIRST focus only.
   *
   * Once, because it tells you the thing you need before you start typing and
   * becomes noise immediately after. Not a tooltip: the point is that dropping
   * a pin is the precise option, and someone who has not learned that yet is
   * exactly the person about to type their house number.
   */
  const [hintSeen, setHintSeen] = useState(false);
  const reduced = useReducedMotion();

  const { suggestions, isLoading, state, coverage } = usePlaceSuggestions({
    query: term,
    ...(citySlug ? { citySlug } : {}),
    enabled: open,
  });

  // Before anything is typed, the saved offices ARE the suggestions — that is
  // the common case for a returning user and it needs no network at all.
  const showSaved = term.trim().length < 2 && savedOffices.length > 0;
  const rowCount = showSaved ? savedOffices.length : suggestions.length;

  useEffect(() => {
    setActiveIndex(0);
  }, [term, showSaved]);

  const commit = (index: number): void => {
    if (showSaved) {
      const office = savedOffices[index];
      if (office && onSelectSaved) onSelectSaved(office);
    } else {
      const result = suggestions[index];
      if (result) onSelect(result);
    }
    setOpen(false);
    setTerm('');
    inputRef.current?.blur();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (rowCount === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + step + rowCount) % rowCount);
      return;
    }

    if (event.key === 'Enter' && open && rowCount > 0) {
      event.preventDefault();
      commit(activeIndex);
      return;
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={cn('relative', className)}>
      <div className="flex items-center gap-2 rounded-chrome border border-input bg-card px-2.5 focus-within:border-water">
        <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && rowCount > 0 ? `${listId}-${String(activeIndex)}` : undefined
          }
          autoComplete="off"
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
          /**
           * "Search a landmark, locality or area near your office", never
           * "Enter your address".
           *
           * The latter promises precision the data cannot deliver — one of ten
           * real addresses with house numbers resolves in this extract — and a
           * box that asks for an address and cannot find one makes a working
           * product feel broken. Proportionate, too: this sets an OFFICE, and
           * being 200 m off changes nothing about which listings fall inside a
           * 1/2/3 km ring.
           */
          placeholder={value || 'Search a landmark, locality or area near your office'}
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            setHintSeen(true);
          }}
          // A click on a row would otherwise be swallowed by the blur.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />

        {isLoading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-ink-faint" aria-hidden />
        ) : null}

        {onUseMyLocation ? (
          <button
            type="button"
            onClick={onUseMyLocation}
            title="Use my current location"
            className="shrink-0 rounded-inset p-1 text-ink-soft hover:bg-accent hover:text-ink"
          >
            {isLocating ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Crosshair className="size-4" aria-hidden />
            )}
            <span className="sr-only">Use my current location</span>
          </button>
        ) : null}
      </div>

      {/* Shown on first focus, before anything is typed, and never again. */}
      {open && !hintSeen && term.length === 0 ? (
        <p className="px-2.5 pt-1 text-data text-ink-faint">
          Landmarks and localities work best. For an exact spot, drop a pin on the map.
        </p>
      ) : null}

      <AnimatePresence>
        {open && (rowCount > 0 || term.trim().length >= 2) ? (
          <motion.div
            initial={reduced ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 1 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="chrome-over absolute top-full left-0 z-30 mt-1 w-full overflow-hidden"
          >
            <ul id={listId} role="listbox" className="max-h-72 overflow-y-auto">
              {showSaved
                ? savedOffices.map((office, index) => (
                    <li
                      key={office.id}
                      id={`${listId}-${String(index)}`}
                      role="option"
                      aria-selected={index === activeIndex}
                    >
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => commit(index)}
                        onMouseEnter={() => setActiveIndex(index)}
                        className={cn(
                          'flex w-full items-center gap-2.5 px-2.5 py-2 text-left',
                          index === activeIndex && 'bg-accent',
                        )}
                      >
                        <Star
                          className={cn(
                            'size-4 shrink-0',
                            office.isDefault ? 'fill-signal text-signal' : 'text-ink-faint',
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{office.label}</span>
                          <span className="block truncate text-data text-ink-faint">
                            {office.address}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))
                : suggestions.map((result, index) => {
                    const Icon = KIND_ICON[result.kind];
                    return (
                      <li
                        key={result.id}
                        id={`${listId}-${String(index)}`}
                        role="option"
                        aria-selected={index === activeIndex}
                      >
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => commit(index)}
                          onMouseEnter={() => setActiveIndex(index)}
                          className={cn(
                            'flex w-full items-center gap-2.5 px-2.5 py-2 text-left',
                            index === activeIndex && 'bg-accent',
                          )}
                        >
                          <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{result.label}</span>
                            {result.context ? (
                              <span className="block truncate text-data text-ink-faint">
                                {result.context}
                              </span>
                            ) : null}
                          </span>
                          {/* What kind of answer this is, before the user
                              commits to it. An `area` row is a city — useful,
                              and not what someone typing a street wanted — so
                              saying so up front is cheaper than letting them
                              select it and wonder. `exact` rows are unlabelled:
                              the good case does not need an apology. */}
                          {result.matchPrecision !== 'exact' ? (
                            <span className="shrink-0 text-data text-ink-faint">
                              {result.matchPrecision === 'locality' ? 'area' : 'city'}
                            </span>
                          ) : null}
                          {/* A source tag per row, so a user can tell our own
                              localities from a wider geocoder result. */}
                          <span className="shrink-0 text-data text-ink-faint">
                            {result.source === 'local' ? 'here' : 'wider search'}
                          </span>
                        </button>
                      </li>
                    );
                  })}

              {/* Three empty cases, three messages, chosen by ONE state value
                  so two can never render at once. Before correction 9 the
                  first two shared a flag, so a query for a city we do not
                  serve read as “the wider search is unavailable” — which
                  invites a retry that can never work. */}
              {rowCount === 0 && term.trim().length >= 2 && !isLoading ? (
                <li className="px-2.5 py-3 text-sm text-ink-soft">
                  {state === 'out_of_coverage' && coverage ? (
                    <>
                      <span className="block">{coverageMessage(coverage)}</span>
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {coverage.supportedCities.map((city) => (
                          <button
                            key={city.slug}
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onPickCity?.(city)}
                            className="rounded-inset border border-edge px-1.5 py-0.5 text-label hover:bg-accent"
                          >
                            {city.name}
                          </button>
                        ))}
                      </span>
                    </>
                  ) : state === 'degraded' ? (
                    <>
                      Nothing of ours matched “{term.trim()}”, and the wider lookup is not answering
                      right now.
                    </>
                  ) : (
                    <>Nothing matched “{term.trim()}”. Try a locality, or drop a pin on the map.</>
                  )}
                </li>
              ) : null}
            </ul>

            {state === 'degraded' && rowCount > 0 ? (
              // Degraded means the wider geocoder could not answer — NOT that
              // there is nothing there. Those are opposite messages.
              <p className="border-t border-edge px-2.5 py-1.5 text-data text-ink-faint">
                Showing our own areas only — the wider lookup is not answering.
              </p>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
