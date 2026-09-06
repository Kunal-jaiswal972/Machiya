import type { FavoriteListing, SavedSearchView } from '@machiya/shared';
import { buildSearchParams, savedSearchToQuery } from '@machiya/shared';
import { Heart, MapPinOff, Play, Trash2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState } from '../components/EmptyState';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/ui/alert-dialog';
import { LoadFailed } from '../components/LoadFailed';
import { Button } from '../components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import {
  useDeleteSavedSearch,
  useFavorites,
  useSavedSearches,
  useToggleFavorite,
} from '../hooks/use-seeker';
import { formatArea, formatBedrooms, formatRupees, humanizeEnum } from '../lib/format';
import { cn } from '../lib/utils';

type Tab = 'favorites' | 'searches';

/**
 * The seeker's two shelves on one page.
 *
 * Together rather than apart because they answer the same question — "what was
 * I looking at" — and a person with three favourites and one saved search does
 * not need two navigation entries to find four things.
 */
export function SavedPage() {
  /**
   * The tab lives in the URL, like the search does.
   *
   * As component state, /saved always reopened on Favourites — so "come back to
   * my saved search" cost an extra tap every visit, Back did not undo the
   * switch, and the tab could not be linked.
   */
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'searches' ? 'searches' : 'favorites';
  const setTab = (next: Tab): void => {
    setParams(next === 'favorites' ? {} : { tab: next }, { replace: true });
  };
  const favorites = useFavorites();
  const searches = useSavedSearches();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-title">Saved</h1>
        <p className="text-sm text-ink-soft">Places you kept, and searches you can re-run.</p>
      </header>

      {/*
        A real tab strip: one Tab stop, arrow keys between the two, and the
        count in its own element so the label cannot widen under the cursor
        when the fetch lands.
      */}
      <ToggleGroup
        type="single"
        value={tab}
        onValueChange={(next) => {
          if (next === 'favorites' || next === 'searches') setTab(next);
        }}
        aria-label="Saved sections"
        className="self-start"
      >
        <ToggleGroupItem value="favorites">
          Favourites
          <span className="text-data ml-1 w-5 text-left text-ink-faint tabular-nums">
            {favorites.data ? favorites.data.length : ''}
          </span>
        </ToggleGroupItem>
        <ToggleGroupItem value="searches">
          Searches
          <span className="text-data ml-1 w-5 text-left text-ink-faint tabular-nums">
            {searches.data ? searches.data.length : ''}
          </span>
        </ToggleGroupItem>
      </ToggleGroup>

      {tab === 'favorites' ? (
        favorites.isError ? (
          <LoadFailed what="your saved places" onRetry={() => void favorites.refetch()} />
        ) : favorites.data && favorites.data.length > 0 ? (
          <ul className="grid gap-2">
            {favorites.data.map((favorite) => (
              <FavoriteRow key={favorite.id} favorite={favorite} />
            ))}
          </ul>
        ) : favorites.isPending ? (
          <RowSkeleton />
        ) : (
          <EmptyState
            illustration="heart"
            title="Nothing saved yet"
            detail="Tap the heart on a listing and it waits for you here, with its price and commute still attached."
            action={
              <Button asChild>
                <Link to="/">Find somewhere</Link>
              </Button>
            }
          />
        )
      ) : searches.isError ? (
        <LoadFailed what="your saved searches" onRetry={() => void searches.refetch()} />
      ) : searches.data && searches.data.length > 0 ? (
        <ul className="grid gap-2">
          {searches.data.map((search) => (
            <SavedSearchRow key={search.id} search={search} />
          ))}
        </ul>
      ) : searches.isPending ? (
        <RowSkeleton />
      ) : (
        <EmptyState
          illustration="search"
          title="No saved searches"
          detail="Set an office, tune the filters, and save it — one tap brings the whole thing back, office and all."
          action={
            <Button asChild>
              <Link to="/">Start a search</Link>
            </Button>
          }
        />
      )}
    </div>
  );
}

function FavoriteRow({ favorite }: { favorite: FavoriteListing }) {
  const toggle = useToggleFavorite();
  const price = favorite.listingType === 'RENT' ? favorite.rentAmount : favorite.salePrice;
  const gone = favorite.status !== 'PUBLISHED';

  return (
    <li className="chrome flex items-center gap-3 p-3">
      <Link
        to={`/listings/${favorite.slug}`}
        className="size-16 shrink-0 overflow-hidden rounded-[var(--radius-inset)] bg-paper-sunken"
      >
        {favorite.coverUrl ? (
          <img src={favorite.coverUrl} alt="" className="size-full object-cover" />
        ) : null}
      </Link>

      <div className="min-w-0 flex-1">
        {/* Kept in the list rather than dropped: the person put it there, and a
            list that silently shrinks has lost information. */}
        {gone ? (
          <p className="text-data text-clay">
            {favorite.status === 'RENTED' ? 'Rented — no longer available' : 'No longer listed'}
          </p>
        ) : null}
        <Link to={`/listings/${favorite.slug}`} className="text-label block truncate">
          {favorite.title ?? 'Untitled'}
        </Link>
        <p className="text-data text-ink-soft">
          {[favorite.locality, favorite.cityName].filter(Boolean).join(' · ')} ·{' '}
          {formatBedrooms(favorite.bedrooms, null)} · {formatArea(favorite.areaSqft)}
        </p>
      </div>

      <p
        className={cn(
          'text-price-lg shrink-0',
          gone ? 'text-ink-faint' : 'text-signal-ink dark:text-signal',
        )}
      >
        {formatRupees(price)}
      </p>

      {/*
        Undo rather than a confirmation. Un-saving is one tap and re-saving is
        one tap, so a dialog would cost more than the mistake — but the toast
        has to carry the way back, and it said nothing at all on success.
      */}
      <Button
        size="icon"
        variant="ghost"
        aria-label="Remove from favourites"
        onClick={() => {
          toggle.mutate(
            { listingId: favorite.id, next: false },
            {
              onSuccess: () => {
                toast.success('Removed from your saved places', {
                  action: {
                    label: 'Undo',
                    onClick: () => toggle.mutate({ listingId: favorite.id, next: true }),
                  },
                });
              },
              onError: () => {
                toast.error('That could not be removed. Try again.');
              },
            },
          );
        }}
      >
        <Heart className="size-4 fill-clay text-clay" aria-hidden />
      </Button>
    </li>
  );
}

function SavedSearchRow({ search }: { search: SavedSearchView }) {
  const remove = useDeleteSavedSearch();

  const href = `/?${buildSearchParams(savedSearchToQuery(search)).toString()}`;

  return (
    <li className="chrome flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <p className="text-label truncate">{search.name}</p>
        <p className="text-data text-ink-soft">
          {(search.radiusMeters / 1000).toFixed(1)} km around {search.officeLat.toFixed(3)},{' '}
          {search.officeLng.toFixed(3)}
          {search.filters.priceMax === undefined
            ? ''
            : ` · under ${formatRupees(search.filters.priceMax)}`}
          {search.filters.bedroomsMin === undefined
            ? ''
            : ` · ${String(search.filters.bedroomsMin)}+ beds`}
          {search.filters.furnishing
            ? ` · ${search.filters.furnishing.map(humanizeEnum).join(', ')}`
            : ''}
        </p>

        {/* A saved search holds coordinates, so it outlives the coverage it was
            saved under. Saying so beats re-running it into an empty result. */}
        {search.covered ? null : (
          <p className="text-data mt-1 flex items-center gap-1 text-clay">
            <MapPinOff className="size-3.5" aria-hidden />
            We no longer cover that office
            {search.nearestCity ? ` — nearest we serve is ${search.nearestCity.name}` : ''}
          </p>
        )}
      </div>

      {search.covered ? (
        <Button asChild size="sm">
          <Link to={href}>
            <Play className="size-3.5" aria-hidden />
            Re-run
          </Link>
        </Button>
      ) : search.nearestCity ? (
        <Button asChild size="sm" variant="secondary">
          <Link to={`/?city=${search.nearestCity.slug}`}>Search {search.nearestCity.name}</Link>
        </Button>
      ) : null}

      {/* A saved search cannot be recreated from the row, so this one asks. */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="icon" variant="ghost" aria-label={`Delete the saved search ${search.name}`}>
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{search.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The office, the radius and the filters go with it. You would have to set them up
              again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                remove.mutate(search.id, {
                  onSuccess: () => toast.success(`“${search.name}” is gone`),
                  onError: () => toast.error('That could not be deleted. Try again.'),
                });
              }}
            >
              Delete it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function RowSkeleton() {
  return (
    <ul className="grid gap-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <li key={row} className="chrome flex items-center gap-3 p-3">
          <div className="size-16 shrink-0 animate-pulse rounded-[var(--radius-inset)] bg-paper-sunken" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded-full bg-paper-sunken" />
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-paper-sunken" />
          </div>
        </li>
      ))}
      <li className="sr-only" role="status">
        Loading what you saved…
      </li>
    </ul>
  );
}
