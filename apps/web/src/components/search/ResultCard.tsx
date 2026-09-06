import type { ListingCard } from '@machiya/shared';
import { BadgeCheck, Heart } from 'lucide-react';
import { Link } from 'react-router';
import { RingBadge } from '../RingBadge';
import { formatArea, formatBedrooms, formatRupees, humanizeEnum } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useSearchUi } from '../../stores/search-ui';

/**
 * A result card. **Number-first** — the risk docs/design.md commits to.
 *
 * Price is the largest element on the card and the photo is a 4:3 band beside
 * it rather than behind it. Every other rental site does the opposite; the bet
 * is that someone comparing homes by cost should see the cost first, and still
 * gets the photo.
 *
 * It is an `<a>`, not a div with an onClick, so it is in the tab order and
 * middle-click and "open in new tab" both work.
 */
export interface ResultCardProps {
  listing: ListingCard;
  /** Preserved so the detail view can return to the same search. */
  searchSuffix: string;
  isFavorite?: boolean;
  onToggleFavorite?: (listingId: string) => void;
}

export function ResultCard({
  listing,
  searchSuffix,
  isFavorite = false,
  onToggleFavorite,
}: ResultCardProps) {
  // Subscribed per card: hovering one card must not re-render sixty.
  const isHovered = useSearchUi((state) => state.hoveredId === listing.id);
  const setHoveredId = useSearchUi((state) => state.setHoveredId);

  const price = listing.listingType === 'RENT' ? listing.rentAmount : listing.salePrice;

  return (
    <Link
      to={`/listings/${listing.slug}${searchSuffix}`}
      onMouseEnter={() => setHoveredId(listing.id)}
      onMouseLeave={() => setHoveredId(null)}
      onFocus={() => setHoveredId(listing.id)}
      onBlur={() => setHoveredId(null)}
      className={cn(
        'flex gap-3 border-b border-edge p-3 transition-colors',
        // The hover state is shared with the map marker; keeping it a background
        // change rather than a transform means no layout work per frame.
        isHovered ? 'bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <div
        className="relative aspect-4/3 w-28 shrink-0 overflow-hidden rounded-chrome bg-paper-sunken"
        // The dominant colour holds the space before the photo paints, so the
        // card does not flash white then fill.
        style={
          listing.coverDominantColor ? { backgroundColor: listing.coverDominantColor } : undefined
        }
      >
        {listing.coverLqip ? (
          <img
            src={listing.coverLqip}
            alt=""
            aria-hidden
            className="absolute inset-0 size-full scale-110 object-cover blur-md"
          />
        ) : null}
        {listing.coverUrl ? (
          <img
            src={listing.coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            width={224}
            height={168}
            className="relative size-full object-cover"
          />
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-price-lg text-signal-ink dark:text-signal">
            {formatRupees(price)}
          </span>
          {listing.listingType === 'RENT' ? (
            <span className="text-label text-ink-faint">/mo</span>
          ) : null}
        </div>

        {/*
          Total true monthly cost: the second-loudest thing on the card, per
          docs/design.md, because it is the product's argument. Absent rather
          than zero when it could not be computed — a city with no scraped fuel
          price yet — since a Rs0 commute would read as a claim.
        */}
        {listing.totalMonthlyCost !== null ? (
          <p className="text-data text-ink-soft" data-tour="total-cost">
            <span className="font-medium tabular-nums text-ink">
              {formatRupees(listing.totalMonthlyCost)}
            </span>{' '}
            all-in
            {listing.commuteMonthly !== null ? (
              <span className="text-ink-faint">
                {' · '}
                {formatRupees(listing.commuteMonthly)} commute
                {listing.commuteEstimated ? ' estimated' : ''}
              </span>
            ) : null}
          </p>
        ) : null}

        {/* Clamped to two lines rather than truncated to one: a 420px panel
            cuts "1 BHK studio in Koramangala" mid-word, and the locality is the
            part someone is scanning for. */}
        <p className="line-clamp-2 text-sm font-medium">
          {listing.title}
          {listing.isVerified ? (
            <BadgeCheck
              className="ml-1 inline size-3.5 -translate-y-px text-verdant"
              aria-label="Verified listing"
            />
          ) : null}
        </p>

        <p className="text-data text-ink-soft">
          {formatBedrooms(listing.bedrooms, listing.propertyType)} · {formatArea(listing.areaSqft)}
        </p>
        {/*
          Two lines rather than one truncated one. "Semi furnished · Ash…" is
          text losing a fight with its container, and the locality is the half
          that gets eaten — which is the half someone is reading for.
        */}
        <p className="text-data text-ink-faint">{humanizeEnum(listing.furnishing)}</p>
        {listing.locality ? (
          <p className="text-data line-clamp-1 text-ink-faint">{listing.locality}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end justify-between gap-2">
        {onToggleFavorite ? (
          <button
            type="button"
            onClick={(event) => {
              // The card is a link; a favourite is not navigation.
              event.preventDefault();
              event.stopPropagation();
              onToggleFavorite(listing.id);
            }}
            className="rounded-inset p-0.5 text-ink-faint hover:text-clay"
            aria-pressed={isFavorite}
          >
            <Heart className={cn('size-4', isFavorite && 'fill-clay text-clay')} aria-hidden />
            <span className="sr-only">
              {isFavorite ? 'Remove from saved' : 'Save this listing'}
            </span>
          </button>
        ) : (
          <span />
        )}

        <RingBadge ring={listing.ring} distanceMeters={listing.distanceMeters} />
      </div>
    </Link>
  );
}
