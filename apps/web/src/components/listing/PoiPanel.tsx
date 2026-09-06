import { POI_CATEGORIES, type Poi, type PoiCategory } from '@machiya/shared';
import { Loader2 } from 'lucide-react';
import { useMapPalette } from '../../hooks/use-map-palette';
import { formatDistance } from '../../lib/format';
import { POI_META } from './poi-meta';
import { cn } from '../../lib/utils';
import { useDetailOverlay } from '../../stores/detail-overlay';

/**
 * Nearby places: a legend that doubles as the map's layer toggles, and the
 * nearest of each category with its distance.
 *
 * The legend IS the control — a separate list of checkboxes beside a colour key
 * would be two things saying the same thing. Clicking a row turns that
 * category's icon layer on over the map.
 */
export interface PoiPanelProps {
  pois: Poi[];
  degraded: boolean;
  isLoading: boolean;
}

export function PoiPanel({ pois, degraded, isLoading }: PoiPanelProps) {
  const palette = useMapPalette();
  const visible = useDetailOverlay((state) => state.visibleCategories);
  const toggleCategory = useDetailOverlay((state) => state.toggleCategory);
  const setCategories = useDetailOverlay((state) => state.setCategories);

  const nearest = new Map<PoiCategory, Poi>();
  const counts = new Map<PoiCategory, number>();

  for (const poi of pois) {
    counts.set(poi.category, (counts.get(poi.category) ?? 0) + 1);
    const best = nearest.get(poi.category);
    if (!best || poi.distanceMeters < best.distanceMeters) nearest.set(poi.category, poi);
  }

  const warming = degraded && pois.length === 0;

  // Only categories with something in them can be shown, so "show all" means
  // all of what exists here rather than seven rows of nothing.
  const available = POI_CATEGORIES.filter((category) => (counts.get(category) ?? 0) > 0);
  const shownCount = available.filter((category) => visible.has(category)).length;
  const allShown = available.length > 0 && shownCount === available.length;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-title">What is nearby</h3>
        {warming ? (
          <span className="text-data flex items-center gap-1 text-ink-faint">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            checking
          </span>
        ) : degraded ? (
          // "Could not refresh" and "there is nothing here" are opposite
          // statements to someone choosing where to live. This says which.
          <span className="text-data text-ink-faint">could not refresh</span>
        ) : null}
      </div>

      {warming ? (
        <p className="text-sm text-ink-soft">
          Looking up hospitals, schools, transit and shops around this address.
          {/* The remaining cause of a stuck panel is the geo profile not being
              up (D48), which is a developer's problem, not a visitor's — so the
              command is dev-only while the sentence above is for everyone. */}
          {import.meta.env.DEV ? (
            <>
              {' '}
              If it does not fill in, the map services are not running:{' '}
              <code className="text-data">docker compose --profile geo up -d</code>.
            </>
          ) : null}
        </p>
      ) : null}

      {available.length > 0 ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-data text-ink-faint">
            {shownCount === 0
              ? 'Nothing on the map yet'
              : `${String(shownCount)} of ${String(available.length)} shown on the map`}
          </p>
          <button
            type="button"
            onClick={() => setCategories(allShown ? [] : available)}
            className="text-label rounded-inset px-1.5 py-0.5 text-water hover:bg-accent"
          >
            {allShown ? 'Hide all' : 'Show all'}
          </button>
        </div>
      ) : null}

      <ul className="flex flex-col">
        {POI_CATEGORIES.map((category) => {
          const meta = POI_META[category];
          const closest = nearest.get(category);
          const count = counts.get(category) ?? 0;
          const isOn = visible.has(category);
          const hasAny = count > 0;

          return (
            <li key={category}>
              <button
                type="button"
                disabled={!hasAny}
                onClick={() => toggleCategory(category)}
                aria-pressed={isOn}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-inset px-1.5 py-1.5 text-left disabled:opacity-45',
                  isOn && 'bg-accent',
                  hasAny && 'hover:bg-accent/60',
                )}
              >
                <span
                  className="grid size-6 shrink-0 place-items-center rounded-round"
                  style={{ backgroundColor: isOn ? palette.poi[category] : 'transparent' }}
                >
                  <meta.Icon
                    className="size-3.5"
                    style={{ color: isOn ? 'var(--color-paper-raised)' : palette.poi[category] }}
                    aria-hidden
                  />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{meta.label}</span>
                  {closest ? (
                    <span className="text-data block truncate text-ink-faint">
                      {closest.name ?? 'nearest'} · {formatDistance(closest.distanceMeters)}
                    </span>
                  ) : (
                    <span className="text-data block text-ink-faint">
                      {isLoading || warming ? '—' : 'none within 1.5 km'}
                    </span>
                  )}
                </span>

                {hasAny ? <span className="text-data text-ink-faint">{count}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="text-data text-ink-faint">
        Tap a category to draw it on the map, then tap a marker for the name and how far it is.
      </p>
    </section>
  );
}
