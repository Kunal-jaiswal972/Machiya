import { cityBboxSchema, type GeocodeResult, type ListingCard } from '@machiya/shared';
import { useMutation } from '@tanstack/react-query';
import { List, Map as MapIcon, Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState } from '../components/EmptyState';
import { FilterBar } from '../components/search/FilterBar';
import { OfficeField } from '../components/search/OfficeField';
import { ResultList } from '../components/search/ResultList';
import { SearchMap } from '../components/search/SearchMap';
import { Button } from '../components/ui/button';
import { env } from '../env';
import { useCities } from '../hooks/use-cities';
import { useListingSearch } from '../hooks/use-listing-search';
import { useOffices, useSaveOffice } from '../hooks/use-offices';
import { useSearchState } from '../hooks/use-search-state';
import { useAuth } from '../lib/auth-context';
import { describeCoordinate, reverseGeocode } from '../lib/places';
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
  const { cities } = useCities();
  const { offices, defaultOffice } = useOffices();
  const saveOffice = useSaveOffice();
  const view = useSearchUi((state) => state.view);
  const setView = useSearchUi((state) => state.setView);

  const [officeLabel, setOfficeLabel] = useState('');
  const [isLocating, setIsLocating] = useState(false);

  const search = useListingSearch(query);

  // Everything the detail view needs to come back to this exact search.
  const searchSuffix = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    return params.size > 0 ? `?${params.toString()}` : '';
  }, [searchParams]);

  const city = useMemo(
    () => cities.find((candidate) => candidate.slug === (query.city ?? env.VITE_DEFAULT_CITY)),
    [cities, query.city],
  );

  const initialBounds = useMemo<[number, number, number, number] | undefined>(() => {
    if (!city) return undefined;
    const bbox = cityBboxSchema.safeParse(city.bbox);
    if (!bbox.success) return undefined;
    return [bbox.data.minLng, bbox.data.minLat, bbox.data.maxLng, bbox.data.maxLat];
  }, [city]);

  // A signed-in user with a default office starts there rather than at a city
  // centroid — it is the whole point of saving one. `replace` so this does not
  // put an entry in the history the back button has to walk through.
  useEffect(() => {
    if (office || !defaultOffice) return;
    setOfficeLabel(defaultOffice.address);
    update({ lat: defaultOffice.lat, lng: defaultOffice.lng }, { replace: true });
  }, [office, defaultOffice, update]);

  /**
   * Naming a point after it is picked.
   *
   * The office moves immediately and the reverse geocode fills the label when
   * it arrives: making the user wait on a network round trip before the rings
   * move would be backwards, and a pin over an unmapped field is a legitimate
   * office that the geocoder simply cannot name.
   */
  const nameOffice = useMutation({
    mutationFn: (point: { lat: number; lng: number }) => reverseGeocode(point),
    onSuccess: (place, point) => {
      setOfficeLabel(
        place?.label
          ? [place.label, place.context].filter(Boolean).join(', ')
          : describeCoordinate(point),
      );
    },
    onError: (_error, point) => {
      setOfficeLabel(describeCoordinate(point));
    },
  });

  const pickOffice = useCallback(
    (point: { lat: number; lng: number }) => {
      setOffice(point);
      nameOffice.mutate(point);
    },
    [setOffice, nameOffice],
  );

  const onSelectSuggestion = useCallback(
    (result: GeocodeResult) => {
      setOfficeLabel([result.label, result.context].filter(Boolean).join(', '));
      setOffice({ lat: result.lat, lng: result.lng });
      if (result.citySlug && result.citySlug !== query.city) {
        update({ city: result.citySlug }, { replace: true });
      }
    },
    [setOffice, update, query.city],
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
          <OfficeField
            value={officeLabel}
            onSelect={onSelectSuggestion}
            savedOffices={offices}
            onSelectSaved={(saved) => {
              setOfficeLabel(saved.address);
              setOffice({ lat: saved.lat, lng: saved.lng });
            }}
            onUseMyLocation={useMyLocation}
            isLocating={isLocating}
            {...(query.city ? { citySlug: query.city } : {})}
            className="max-w-lg flex-1"
          />

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
          <div className="ml-auto flex items-center gap-0.5 rounded-chrome border border-edge p-0.5 lg:hidden">
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

        {office ? (
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
          {office ? (
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
            />
          ) : (
            <EmptyState
              illustration="search"
              title="Start with where you work."
              detail="Search for your office, or click anywhere on the map to drop a pin. Everything is measured from there."
            />
          )}
        </div>

        <div className={cn('min-h-0 flex-1', view === 'list' ? 'hidden lg:block' : 'block')}>
          <SearchMap
            office={office}
            radiusMeters={radiusMeters}
            listings={search.listings}
            initialBounds={initialBounds}
            onPickOffice={pickOffice}
            onSelectListing={onSelectListing}
          />
        </div>
      </div>
    </div>
  );
}
