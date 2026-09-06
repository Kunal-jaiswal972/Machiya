import {
  precisionNote,
  type GeocodeResult,
  type ListingCard,
  type MatchPrecision,
  type OutOfCoverage,
} from '@machiya/shared';
import { HelpCircle, List, Map as MapIcon, Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useMatch, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState } from '../components/EmptyState';
import { CoverageNotice } from '../components/search/CoverageNotice';
import { FilterBar } from '../components/search/FilterBar';
import { OfficeField } from '../components/search/OfficeField';
import { ResultList } from '../components/search/ResultList';
import { SearchMap } from '../components/search/SearchMap';
import { Button } from '../components/ui/button';
import { useCloseDetail } from '../hooks/use-close-detail';
import { useUiPreferences } from '../hooks/use-ui-preferences';
import { useCoverage, nearestCoveredCity } from '../hooks/use-coverage';
import { useReverseGeocode } from '../hooks/use-reverse-geocode';
import { useListingSearch } from '../hooks/use-listing-search';
import { useOffices, useSaveOffice } from '../hooks/use-offices';
import { useSearchState } from '../hooks/use-search-state';
import { useFavoriteIds, useToggleFavorite } from '../hooks/use-seeker';
import { useAuth } from '../lib/auth-context';
import { describeCoordinate } from '../lib/places';
import { startTour } from '../lib/tour';
import { cn } from '../lib/utils';
import { useSearchUi } from '../stores/search-ui';

/**
 * The product.
 *
 * Composition, and it is deliberate: the map is the ground and the list is the
 * canonical, accessible representation of the same results. Both read one
 * source of truth — the URL — so a shared link reproduces the view exactly.
 *
 * On mobile the two become one column with a view toggle rather than a squeezed
 * two-pane layout, because a 340px list beside a 20px map serves neither.
 */
export function SearchPage() {
  const { query, office, radiusMeters, activeFilterCount, update, setOffice, clearFilters } =
    useSearchState();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const favoriteIds = useFavoriteIds();
  const toggleFavorite = useToggleFavorite();
  const { cities, maxBounds } = useCoverage();
  const { offices, defaultOffice } = useOffices();
  const saveOffice = useSaveOffice();
  const closeDetail = useCloseDetail();
  const ui = useUiPreferences();
  const isDetailOpen = useMatch('/listings/:slug') !== null;
  const view = useSearchUi((state) => state.view);
  const setView = useSearchUi((state) => state.setView);

  const [officeLabel, setOfficeLabel] = useState('');
  const [isLocating, setIsLocating] = useState(false);
  /**
   * The out-of-coverage state from a REVERSE geocode — a pin dropped outside
   * coverage — as opposed to the one the search itself returns.
   *
   * Held separately because it arrives first: the pin moves immediately and the
   * naming request answers before the search does, so this is what lets the
   * panel switch to the coverage state without a flash of "no listings".
   */
  const [pinCoverage, setPinCoverage] = useState<OutOfCoverage | null>(null);
  /**
   * How precise the office label is, so the UI can say what it actually did.
   *
   * "Showing Rajendra Nagar — drag the pin to your exact spot" is the honest
   * line when a full street address resolved only to its locality, which is the
   * usual outcome: `addr:housenumber` tagging in Indian cities is sparse and no
   * change of geocoder fixes that. Null once the pin has been placed by hand,
   * because then the precision came from the pin. See DECISIONS.md D59.
   */
  const [officePrecision, setOfficePrecision] = useState<MatchPrecision | null>(null);

  const search = useListingSearch(query);

  /**
   * The tour runs itself once, and only when there is something to point at.
   *
   * After the first search returns rather than on load: half its steps are
   * about results, and a tour of an empty page teaches nothing. It marks itself
   * seen when it ends, however it ends.
   */
  const runTour = useCallback(() => {
    startTour({ onFinished: () => ui.update({ tourCompletedAt: new Date().toISOString() }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` is rebuilt each render
  }, [ui.preferences]);

  useEffect(() => {
    // Not while the account's answer is still in flight: starting on a guess
    // would run the tour again for someone who finished it on another device.
    if (ui.isLoading || ui.preferences.tourCompletedAt || search.listings.length === 0) return;

    const timer = window.setTimeout(runTour, 600);
    return () => window.clearTimeout(timer);
  }, [ui.isLoading, ui.preferences.tourCompletedAt, search.listings.length, runTour]);

  // One value for the two ways a point can be out of coverage. The pin's answer
  // wins because it lands first, and because the search is not even run for a
  // point the reverse geocode has already refused.
  const coverage = pinCoverage ?? search.outOfCoverage;

  // Everything the detail view needs to come back to this exact search.
  const searchSuffix = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    return params.size > 0 ? `?${params.toString()}` : '';
  }, [searchParams]);

  /**
   * Which covered city the map opens on.
   *
   * The one named in the URL, otherwise the one NEAREST the visitor's own
   * timezone-free best guess — which here is simply the first covered city,
   * because a browser that has not been asked for geolocation has nothing
   * better to offer and asking on page load would be rude. `VITE_DEFAULT_CITY`
   * is gone: the served set comes from `/api/coverage`, so a build-time default
   * could name a city the deployment does not cover.
   */
  const city = useMemo(() => {
    if (query.city) {
      const named = cities.find((candidate) => candidate.slug === query.city);
      if (named) return named;
    }
    if (office) return nearestCoveredCity(cities, office);
    return cities[0];
  }, [cities, query.city, office]);

  const initialBounds = useMemo<[number, number, number, number] | undefined>(() => {
    if (!city) return undefined;
    return [city.bbox.minLng, city.bbox.minLat, city.bbox.maxLng, city.bbox.maxLat];
  }, [city]);

  // A signed-in user with a default office starts there rather than at a city
  // centroid — it is the whole point of saving one. `replace` so this does not
  // put an entry in the history the back button has to walk through.
  useEffect(() => {
    if (office || !defaultOffice) return;
    setOfficePrecision(null);
    setOfficeLabel(defaultOffice.address);
    update({ lat: defaultOffice.lat, lng: defaultOffice.lng }, { replace: true });
  }, [office, defaultOffice, update]);

  /**
   * Naming a point after it is picked.
   *
   * The office moves immediately and the label arrives when it arrives — see
   * `useReverseGeocode`. A dropped pin IS the exact spot whatever the geocoder
   * manages to call it, so the precision note is cleared: the label describes
   * the point, it is not the source of its precision.
   */
  const nameOffice = useReverseGeocode({
    onNamed: (label) => {
      setOfficePrecision(null);
      setOfficeLabel(label);
    },
    onCoverage: setPinCoverage,
  });

  const pickOffice = useCallback(
    (point: { lat: number; lng: number }) => {
      setOffice(point);
      nameOffice.name(point);
    },
    [setOffice, nameOffice],
  );

  const onSelectSuggestion = useCallback(
    (result: GeocodeResult) => {
      // A suggestion always came from inside coverage: tier 1 only holds our
      // own rows and tier 2's Nominatim imported only the covered extracts. So
      // any pin-coverage state from a previous click is stale here.
      setPinCoverage(null);
      setOfficePrecision(result.matchPrecision);
      setOfficeLabel([result.label, result.context].filter(Boolean).join(', '));
      setOffice({ lat: result.lat, lng: result.lng });
      if (result.citySlug && result.citySlug !== query.city) {
        update({ city: result.citySlug }, { replace: true });
      }
    },
    [setOffice, update, query.city],
  );

  /**
   * Move the whole search to a covered city.
   *
   * The one-tap action on every coverage message. The office moves to the
   * city's centroid rather than being cleared, because "show me Bengaluru" is
   * what someone means when they tap Bengaluru, and an empty office field is
   * one more thing to fill in.
   */
  const onPickCoveredCity = useCallback(
    (picked: OutOfCoverage['supportedCities'][number]) => {
      setPinCoverage(null);
      setOfficePrecision('area');
      setOfficeLabel(picked.name);
      update({ city: picked.slug, lat: picked.centroid.lat, lng: picked.centroid.lng });
    },
    [update],
  );

  const onSelectListing = useCallback(
    (listing: ListingCard) => {
      void navigate(`/listings/${listing.slug}${searchSuffix}`);
    },
    [navigate, searchSuffix],
  );

  const useMyLocation = useCallback(() => {
    if (!('geolocation' in navigator)) {
      toast.error('This browser cannot share a location. Search for the address instead.');
      return;
    }

    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        pickOffice({ lat: position.coords.latitude, lng: position.coords.longitude });
      },
      () => {
        setIsLocating(false);
        // Denied permission is a choice, not a fault — say what to do instead.
        toast.error('Location is blocked. Search for your office address instead.');
      },
      { timeout: 8_000 },
    );
  }, [pickOffice]);

  const onSaveOffice = useCallback(() => {
    if (!office) return;

    saveOffice.mutate(
      {
        label: officeLabel.split(',')[0]?.trim() || 'My office',
        address: officeLabel || describeCoordinate(office),
        lat: office.lat,
        lng: office.lng,
        isDefault: offices.length === 0,
      },
      {
        // Same verb as the control that started it.
        onSuccess: () => toast.success('Office saved'),
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : 'That office could not be saved'),
      },
    );
  }, [office, officeLabel, offices.length, saveOffice]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="z-20 flex shrink-0 flex-col gap-2 border-b border-edge bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="max-w-lg flex-1" data-tour="office-field">
            <OfficeField
              value={officeLabel}
              onSelect={onSelectSuggestion}
              savedOffices={offices}
              onSelectSaved={(saved) => {
                // A saved office was pinned when it was saved.
                setOfficePrecision(null);
                setOfficeLabel(saved.address);
                setOffice({ lat: saved.lat, lng: saved.lng });
              }}
              onUseMyLocation={useMyLocation}
              isLocating={isLocating}
              {...(query.city ? { citySlug: query.city } : {})}
              onPickCity={onPickCoveredCity}
            />
          </div>

          <Button
            variant="ghost"
            size="icon"
            onClick={runTour}
            title="How this works"
            className="shrink-0"
          >
            <HelpCircle aria-hidden />
            <span className="sr-only">How this works</span>
          </Button>

          {office && isSignedIn ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onSaveOffice}
              disabled={saveOffice.isPending}
            >
              <Star aria-hidden />
              Save office
            </Button>
          ) : null}

          {/* The list view is the keyboard and screen-reader path, and a real
              toggle anyone can use rather than a hidden fallback. */}
          <div
            className="ml-auto flex items-center gap-0.5 rounded-chrome border border-edge p-0.5 lg:hidden"
            data-tour="view-toggle"
          >
            {(
              [
                { value: 'map', label: 'Map', Icon: MapIcon },
                { value: 'list', label: 'List', Icon: List },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setView(option.value)}
                aria-pressed={view === option.value}
                className={cn(
                  'flex items-center gap-1 rounded-inset px-2 py-1 text-label',
                  view === option.value ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <option.Icon className="size-3.5" aria-hidden />
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* What the geocoder actually did, when it did less than asked. Above
            the filter bar because it is about the office the filters are
            measured from, and silent for an exact match — the good case needs
            no note. */}
        {office && !coverage && officePrecision && officePrecision !== 'exact' ? (
          <p className="text-data text-ink-soft">
            {precisionNote({
              precision: officePrecision,
              label: officeLabel.split(',')[0]?.trim() || 'that area',
            })}
          </p>
        ) : null}

        {office && !coverage ? (
          <FilterBar
            query={query}
            radiusMeters={radiusMeters}
            ringCounts={search.ringCounts}
            total={search.total}
            activeFilterCount={activeFilterCount}
            update={update}
            clearFilters={clearFilters}
          />
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            'min-h-0 w-full shrink-0 overflow-y-auto border-edge lg:w-[420px] lg:border-r',
            view === 'map' ? 'hidden lg:block' : 'block',
          )}
        >
          {/* Order matters. Coverage is checked BEFORE the result list, because
              out of coverage the list is empty and would read as "this product
              has no listings" — which is the whole confusion correction 9
              removes. `pinCoverage` comes first because it arrives first: the
              reverse geocode answers before the search does. */}
          {coverage ? (
            <CoverageNotice coverage={coverage} onPickCity={onPickCoveredCity} />
          ) : office ? (
            <ResultList
              listings={search.listings}
              total={search.total}
              isLoading={search.isLoading}
              isFetchingNextPage={search.isFetchingNextPage}
              hasNextPage={search.hasNextPage}
              fetchNextPage={search.fetchNextPage}
              searchSuffix={searchSuffix}
              hasFilters={activeFilterCount > 0}
              onClearFilters={clearFilters}
              favoriteIds={favoriteIds}
              onToggleFavorite={(listingId) => {
                if (!isSignedIn) {
                  toast.info('Sign in to keep a place');
                  return;
                }
                toggleFavorite.mutate({
                  listingId,
                  next: !favoriteIds.has(listingId),
                });
              }}
            />
          ) : (
            <EmptyState
              illustration="search"
              title="Start with where you work."
              detail="Search a landmark, locality or area near your office — or drop a pin anywhere on the map. Everything is measured from there."
            />
          )}
        </div>

        <div
          className={cn('relative min-h-0 flex-1', view === 'list' ? 'hidden lg:block' : 'block')}
        >
          <SearchMap
            office={office}
            radiusMeters={radiusMeters}
            listings={search.listings}
            initialBounds={initialBounds}
            maxBounds={maxBounds}
            onPickOffice={pickOffice}
            onSelectListing={onSelectListing}
            onDismissDetail={isDetailOpen ? closeDetail : undefined}
          />

          {/* The detail panel renders over the map, inside its stacking
              context, so it springs in from the map's own right edge. */}
          <Outlet />
        </div>
      </div>
    </div>
  );
}
