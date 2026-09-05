import type { ListingStatus, OwnedListing } from '@machiya/shared';
import {
  BadgeCheck,
  Copy,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Eye,
  Heart,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AnalyticsCards } from '../../components/lister/AnalyticsCards';
import { EmptyState } from '../../components/EmptyState';
import { Button } from '../../components/ui/button';
import {
  useDuplicateListing,
  useListerAnalytics,
  useListingStatusAction,
  useMyListings,
} from '../../hooks/use-my-listings';
import { formatRupees, humanizeEnum } from '../../lib/format';
import { cn } from '../../lib/utils';

const FILTERS: { label: string; value: ListingStatus | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Live', value: 'PUBLISHED' },
  { label: 'Drafts', value: 'DRAFT' },
  { label: 'Paused', value: 'PAUSED' },
  { label: 'Rented', value: 'RENTED' },
];

export function DashboardPage() {
  const [status, setStatus] = useState<ListingStatus | undefined>(undefined);
  const listings = useMyListings(status);
  const analytics = useListerAnalytics();

  const rows = listings.data?.listings ?? [];
  const nothingAtAll = !listings.isPending && rows.length === 0 && status === undefined;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-title">Your listings</h1>
          <p className="text-sm text-ink-soft">
            What is live, what it is doing, and what still needs finishing.
          </p>
        </div>
        <Button asChild>
          <Link to="/lister/listings/new">
            <Plus className="size-4" aria-hidden />
            List a property
          </Link>
        </Button>
      </header>

      {analytics.data ? <AnalyticsCards analytics={analytics.data} /> : null}

      <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
        {FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            onClick={() => {
              setStatus(filter.value);
            }}
            aria-pressed={status === filter.value}
            className={cn(
              'text-label rounded-[var(--radius-chrome)] border px-2.5 py-1',
              status === filter.value
                ? 'border-water bg-water-soft'
                : 'border-edge-strong text-ink-soft hover:bg-paper-sunken',
            )}
          >
            {filter.label}
          </button>
        ))}
      </nav>

      {listings.isPending ? (
        <ListSkeleton />
      ) : nothingAtAll ? (
        <EmptyState
          illustration="listing"
          title="You have not listed anything yet"
          detail="Start with the map: drop a pin on the property and the wizard fills in from there. Everything saves as you go, so you can stop whenever."
          action={
            <Button asChild>
              <Link to="/lister/listings/new">List your first property</Link>
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          illustration="search"
          title={`Nothing ${FILTERS.find((f) => f.value === status)?.label.toLowerCase() ?? ''}`}
          detail="Try another filter — your other listings are still there."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setStatus(undefined);
              }}
            >
              Show all
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-2">
          {rows.map((listing) => (
            <ListingRow key={listing.id} listing={listing} />
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_STYLE: Record<ListingStatus, string> = {
  PUBLISHED: 'bg-verdant-soft text-verdant',
  DRAFT: 'bg-paper-sunken text-ink-soft',
  PAUSED: 'bg-signal/25 text-signal-ink dark:text-signal',
  RENTED: 'bg-water-soft text-water',
};

function ListingRow({ listing }: { listing: OwnedListing }) {
  const navigate = useNavigate();
  const statusAction = useListingStatusAction();
  const duplicate = useDuplicateListing();

  const price = listing.listingType === 'RENT' ? listing.rentAmount : listing.salePrice;
  const isDraft = listing.status === 'DRAFT';

  return (
    <li className="chrome flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'text-data rounded-[var(--radius-inset)] px-1.5 py-0.5',
              STATUS_STYLE[listing.status],
            )}
          >
            {humanizeEnum(listing.status)}
          </span>
          {listing.isVerified ? (
            <BadgeCheck className="size-3.5 text-verdant" aria-label="Verified" />
          ) : null}
          {listing.imageCount === 0 ? <span className="text-data text-clay">no photos</span> : null}
        </div>

        <p className="text-label mt-1 truncate">
          {/* A draft that has not reached the step that names it (D67). */}
          {listing.title ?? 'Untitled draft'}
        </p>
        <p className="text-data text-ink-soft">
          {[listing.locality, humanizeEnum(listing.propertyType)].filter(Boolean).join(' · ')}
        </p>
      </div>

      <p className="text-price-lg shrink-0 text-signal-ink dark:text-signal">
        {formatRupees(price)}
      </p>

      <dl className="text-data flex shrink-0 gap-3 text-ink-soft">
        <Metric
          icon={<Eye className="size-3.5" aria-hidden />}
          label="views"
          value={listing.viewCount}
        />
        <Metric
          icon={<Heart className="size-3.5" aria-hidden />}
          label="saves"
          value={listing.favoriteCount}
        />
        <Metric
          icon={<MessageSquare className="size-3.5" aria-hidden />}
          label="enquiries"
          value={listing.enquiryCount}
        />
      </dl>

      <div className="flex shrink-0 gap-1">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            navigate(`/lister/listings/${listing.id}/edit?step=${isDraft ? 'location' : 'review'}`);
          }}
        >
          <Pencil className="size-3.5" aria-hidden />
          {isDraft ? 'Finish' : 'Edit'}
        </Button>

        <Button
          size="icon"
          variant="ghost"
          aria-label="Duplicate this listing"
          disabled={duplicate.isPending}
          onClick={() => {
            duplicate.mutate(listing.id, {
              onSuccess: (copy) => {
                toast.success('Copied as a new draft — photos are not carried over');
                navigate(`/lister/listings/${copy.id}/edit?step=basics`);
              },
              onError: () => {
                toast.error('Could not duplicate that listing');
              },
            });
          }}
        >
          <Copy className="size-3.5" aria-hidden />
        </Button>

        {listing.status === 'PUBLISHED' || listing.status === 'PAUSED' ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label={listing.status === 'PAUSED' ? 'Put back on the map' : 'Pause this listing'}
            disabled={statusAction.isPending}
            onClick={() => {
              statusAction.mutate(
                {
                  id: listing.id,
                  action: listing.status === 'PAUSED' ? 'unpause' : 'pause',
                },
                {
                  onSuccess: () => {
                    toast.success(listing.status === 'PAUSED' ? 'Back on the map' : 'Paused');
                  },
                  onError: () => {
                    toast.error('Could not change that listing');
                  },
                },
              );
            }}
          >
            {listing.status === 'PAUSED' ? (
              <Play className="size-3.5" aria-hidden />
            ) : (
              <Pause className="size-3.5" aria-hidden />
            )}
          </Button>
        ) : null}

        {listing.status === 'PUBLISHED' || listing.status === 'PAUSED' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              statusAction.mutate(
                { id: listing.id, action: 'mark-rented' },
                {
                  onSuccess: () => {
                    toast.success('Marked as rented — it comes off the map');
                  },
                  onError: () => {
                    toast.error('Could not change that listing');
                  },
                },
              );
            }}
          >
            Rented
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1">
      {icon}
      <span className="sr-only">{label}</span>
      {value}
    </div>
  );
}

/** Shaped like the rows it replaces, not a generic bar (docs/design.md). */
function ListSkeleton() {
  return (
    <ul className="grid gap-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <li key={row} className="chrome flex items-center gap-3 p-3">
          <div className="flex-1">
            <div className="h-3 w-16 animate-pulse rounded-full bg-paper-sunken" />
            <div className="mt-2 h-4 w-2/3 animate-pulse rounded-full bg-paper-sunken" />
            <div className="mt-1.5 h-3 w-1/3 animate-pulse rounded-full bg-paper-sunken" />
          </div>
          <div className="h-7 w-24 animate-pulse rounded-full bg-paper-sunken" />
        </li>
      ))}
      <li className="sr-only" role="status">
        Loading your listings…
      </li>
    </ul>
  );
}
