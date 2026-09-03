import type { GeocodeResult } from '@machiya/shared';
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
  className,
}: OfficeFieldProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const reduced = useReducedMotion();

  const { suggestions, isLoading, isDegraded } = usePlaceSuggestions({
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
          placeholder={value || 'Where do you work?'}
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
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
                          {/* A source tag per row, so a user can tell our own
                              localities from a wider geocoder result. */}
                          <span className="shrink-0 text-data text-ink-faint">
                            {result.source === 'local' ? 'here' : 'osm'}
                          </span>
                        </button>
                      </li>
                    );
                  })}

              {rowCount === 0 && term.trim().length >= 2 && !isLoading ? (
                <li className="px-2.5 py-3 text-sm text-ink-soft">
                  Nothing matched “{term.trim()}”. Try a locality, or click the map to drop a pin.
                </li>
              ) : null}
            </ul>

            {isDegraded && rowCount > 0 ? (
              // Degraded means the wider geocoder could not answer — NOT that
              // there is nothing there. Those are opposite messages.
              <p className="border-t border-edge px-2.5 py-1.5 text-data text-ink-faint">
                Showing local matches only — the wider search is unavailable.
              </p>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
