import type { RouteProfile } from '@machiya/shared';
import { AnimatePresence } from 'motion/react';
import { BadgeCheck, Bike, Car, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { DetailPanel } from '../components/listing/DetailPanel';
import { EnquiryForm } from '../components/listing/EnquiryForm';
import { Gallery } from '../components/listing/Gallery';
import { CommutePanel } from '../components/listing/CommutePanel';
import { PoiPanel } from '../components/listing/PoiPanel';
import { RingGauge } from '../components/RingGauge';
import { DetailSkeleton } from '../components/Skeletons';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/ui/button';
import {
  useListingDetail,
  useListingPois,
  useListingRoute,
  useRecordView,
  useSimilarListings,
} from '../hooks/use-listing';
import { useCommutePreferences, useListingCommute } from '../hooks/use-commute';
import { useSearchState } from '../hooks/use-search-state';
import {
  formatArea,
  formatAvailability,
  formatBedrooms,
  formatDistance,
  formatDuration,
  formatRupees,
  humanizeEnum,
} from '../lib/format';
import { cn } from '../lib/utils';
import { useDetailOverlay } from '../stores/detail-overlay';

/**
 * The listing detail, rendered as a panel over the search rather than a page of
 * its own.
 *
 * It is a CHILD route of the search page, which is what keeps the map mounted:
 * navigating to a listing should not tear down and re-instantiate a WebGL map,
 * refetch its tiles and lose the camera. Closing is `navigate(-1)` when there
 * is history to go back to, so the search returns exactly as it was.
 */
export function ListingDetailRoute() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { office } = useSearchState();
  const [profile, setProfile] = useState<RouteProfile>('car');

  const detail = useListingDetail(slug);
  const pois = useListingPois(slug);
  const similar = useSimilarListings(slug);
  const { commute } = useListingCommute({ slug, office });
  const commutePreferences = useCommutePreferences();
  const route = useListingRoute({ slug, from: office, profile });
  const recordView = useRecordView();

  const setListing = useDetailOverlay((state) => state.setListing);
  const setRouteGeometry = useDetailOverlay((state) => state.setRouteGeometry);
  const setPois = useDetailOverlay((state) => state.setPois);
  const clearOverlay = useDetailOverlay((state) => state.clear);

  const listing = detail.data?.listing;

  // One ping per mount. The server deduplicates by viewer and window, so a
  // remount inside 30 minutes counts once.
  useEffect(() => {
    if (slug) recordView.mutate(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per slug
  }, [slug]);

  useEffect(() => {
    setListing(listing?.id ?? null);
    return () => clearOverlay();
  }, [listing?.id, setListing, clearOverlay]);

  useEffect(() => {
    setRouteGeometry(route.data?.route.geometry ?? null);
  }, [route.data, setRouteGeometry]);

  useEffect(() => {
    setPois(pois.data?.pois ?? []);
  }, [pois.data, setPois]);

  const close = (): void => {
    // Back when there is somewhere to go back to, so the search restores with
    // its scroll position; otherwise a fresh navigation to the same search.
    if (window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate({ pathname: '/', search: searchParams.toString() });
    }
  };

  const price = listing
    ? listing.listingType === 'RENT'
      ? listing.rentAmount
      : listing.salePrice
    : null;

  const searchSuffix = searchParams.size > 0 ? `?${searchParams.toString()}` : '';

  return (
    <AnimatePresence>
      <DetailPanel key={slug} onClose={close}>
        {detail.isPending ? (
          <DetailSkeleton />
        ) : detail.isError || !listing ? (
          <EmptyState
            illustration="search"
            title="That listing is not here."
            detail="It may have been unpublished or removed."
            action={
              <Button size="sm" onClick={close}>
                Back to results
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-5 p-3 pt-11">
            <Gallery images={listing.images} title={listing.title ?? 'Untitled draft'} />

            {/* Price loudest, road distance second — the product's argument. */}
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-price-xl text-signal-ink dark:text-signal">
                    {formatRupees(price)}
                  </span>
                  {listing.listingType === 'RENT' ? (
                    <span className="text-label text-ink-faint">/mo</span>
                  ) : null}
                </div>
                <h2 className="text-title mt-1 text-balance">
                  {listing.title ?? 'Untitled draft'}
                  {listing.isVerified ? (
                    <BadgeCheck
                      className="ml-1.5 inline size-4 -translate-y-px text-verdant"
                      aria-label="Verified listing"
                    />
                  ) : null}
                </h2>
                {/* The address already carries the locality and city, so the
                    city name is not repeated — only the state, which it does
                    not include. */}
                <p className="text-data mt-0.5 text-ink-soft">
                  {[listing.address ?? listing.locality, listing.city.state]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>

              {route.data ? (
                <RingGauge
                  ring={ringFor(route.data.route.distanceMeters)}
                  distanceMeters={route.data.route.distanceMeters / 1.35}
                  roadMeters={route.data.route.distanceMeters}
                  size={56}
                />
              ) : null}
            </header>

            {/* --- commute -------------------------------------------------- */}
            {office ? (
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-title">Commute from your office</h3>
                  <div className="flex items-center gap-0.5 rounded-chrome border border-edge p-0.5">
                    {(
                      [
                        { value: 'car', label: 'Car', Icon: Car },
                        { value: 'bike', label: 'Bike', Icon: Bike },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setProfile(option.value)}
                        aria-pressed={profile === option.value}
                        className={cn(
                          'flex items-center gap-1 rounded-inset px-2 py-1 text-label',
                          profile === option.value ? 'bg-accent' : 'hover:bg-accent/60',
                        )}
                      >
                        <option.Icon className="size-3.5" aria-hidden />
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                {route.isPending ? (
                  <p className="text-data text-ink-faint">measuring…</p>
                ) : route.data ? (
                  <>
                    <dl className="grid grid-cols-2 gap-2">
                      <Fact
                        label="By road"
                        value={formatDistance(route.data.route.distanceMeters)}
                      />
                      <Fact
                        label="Travel time"
                        value={formatDuration(route.data.route.durationSeconds)}
                      />
                    </dl>
                    {route.data.route.degraded ? (
                      // An estimate presented as a measurement would undermine
                      // the one thing this product is selling.
                      <p className="text-data flex items-start gap-1.5 text-ink-faint">
                        <TriangleAlert className="mt-px size-3 shrink-0 text-clay" aria-hidden />
                        Estimated from straight-line distance — the routing service is unavailable,
                        so this is not a measured road route.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : (
              <p className="text-sm text-ink-soft">
                Set an office on the search to see the commute from it.
              </p>
            )}

            {/* Cost follows distance, because it is computed from it. */}
            {commute ? (
              <CommutePanel
                commute={commute}
                preferences={commutePreferences.preferences}
                onChange={commutePreferences.update}
                isPersisted={commutePreferences.isPersisted}
              />
            ) : null}

            {/* --- the facts ------------------------------------------------ */}
            <section>
              <h3 className="text-title mb-2">The place</h3>
              <dl className="grid grid-cols-2 gap-2">
                <Fact
                  label="Layout"
                  value={formatBedrooms(listing.bedrooms, listing.propertyType)}
                />
                <Fact
                  label="Bathrooms"
                  value={listing.bathrooms === null ? '—' : String(listing.bathrooms)}
                />
                <Fact label="Area" value={formatArea(listing.areaSqft)} />
                <Fact label="Furnishing" value={humanizeEnum(listing.furnishing)} />
                <Fact label="Type" value={humanizeEnum(listing.propertyType)} />
                <Fact
                  label="Floor"
                  value={
                    listing.floor === null
                      ? '—'
                      : `${String(listing.floor)}${listing.totalFloors === null ? '' : ` of ${String(listing.totalFloors)}`}`
                  }
                />
                {listing.listingType === 'RENT' ? (
                  <>
                    <Fact label="Deposit" value={formatRupees(listing.securityDeposit)} />
                    <Fact label="Maintenance" value={formatRupees(listing.maintenanceMonthly)} />
                  </>
                ) : null}
                <Fact label="Available" value={formatAvailability(listing.availableFrom)} />
              </dl>
            </section>

            <section>
              <h3 className="text-title mb-1">About</h3>
              <p className="text-sm whitespace-pre-line">
                {listing.description ?? 'No description yet.'}
              </p>
            </section>

            {listing.amenities.length > 0 ? (
              <section>
                <h3 className="text-title mb-2">Amenities</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {listing.amenities.map((amenity) => (
                    <li
                      key={amenity.id}
                      className="rounded-inset border border-edge px-2 py-0.5 text-label"
                    >
                      {amenity.name}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {listing.rules.length > 0 ? (
              <section>
                <h3 className="text-title mb-2">House rules</h3>
                <ul className="flex flex-col gap-1">
                  {listing.rules.map((rule) => (
                    <li key={rule} className="text-sm text-ink-soft">
                      {rule}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <PoiPanel
              pois={pois.data?.pois ?? []}
              degraded={pois.data?.degraded ?? false}
              isLoading={pois.isPending}
            />

            {/* --- owner ---------------------------------------------------- */}
            <section className="flex items-center gap-3 rounded-chrome border border-edge p-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-round bg-paper-sunken text-label">
                {listing.owner.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{listing.owner.name}</span>
                <span className="text-data block text-ink-faint">
                  {listing.owner.phone === null
                    ? 'Contact shown after you enquire'
                    : listing.owner.phone}
                </span>
              </span>
            </section>

            <EnquiryForm
              listingSlug={listing.slug}
              ownerName={listing.owner.name}
              viewerIsOwner={detail.data.viewerIsOwner}
              viewerHasEnquired={detail.data.viewerHasEnquired}
            />

            {/* --- similar -------------------------------------------------- */}
            {similar.data && similar.data.listings.length > 0 ? (
              <section>
                <h3 className="text-title mb-2">Similar nearby</h3>
                <ul className="flex gap-2 overflow-x-auto pb-1">
                  {similar.data.listings.map((card) => (
                    <li key={card.id} className="w-40 shrink-0">
                      <Link
                        to={`/listings/${card.slug}${searchSuffix}`}
                        className="flex flex-col gap-1"
                      >
                        <span
                          className="aspect-4/3 w-full overflow-hidden rounded-chrome bg-paper-sunken"
                          style={
                            card.coverDominantColor
                              ? { backgroundColor: card.coverDominantColor }
                              : undefined
                          }
                        >
                          {card.coverUrl ? (
                            <img
                              src={card.coverUrl}
                              alt=""
                              loading="lazy"
                              className="size-full object-cover"
                            />
                          ) : null}
                        </span>
                        <span className="text-sm font-semibold text-signal-ink dark:text-signal">
                          {formatRupees(
                            card.listingType === 'RENT' ? card.rentAmount : card.salePrice,
                          )}
                        </span>
                        <span className="text-data truncate text-ink-soft">
                          {formatBedrooms(card.bedrooms, card.propertyType)} ·{' '}
                          {formatDistance(card.distanceMeters)} away
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <p className="text-data text-ink-faint">
              {listing.viewCount === 1 ? '1 view' : `${String(listing.viewCount)} views`}
            </p>
          </div>
        )}
      </DetailPanel>
    </AnimatePresence>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-chrome border border-edge px-2.5 py-1.5">
      <dt className="text-data text-ink-faint">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

/** Which band a ROAD distance falls in, for the gauge in the header. */
function ringFor(meters: number): 1 | 2 | 3 {
  if (meters <= 1000) return 1;
  if (meters <= 2000) return 2;
  return 3;
}
