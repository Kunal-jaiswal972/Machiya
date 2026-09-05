import type { AdminListing } from '@machiya/shared';
import { BadgeCheck, ExternalLink, ShieldOff } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { EmptyState } from '../../components/EmptyState';
import { Button } from '../../components/ui/button';
import { useModerationQueue, useVerifyListing } from '../../hooks/use-admin';
import { formatRupees } from '../../lib/format';

/**
 * Newly published listings, oldest first.
 *
 * Oldest first is the whole point of a queue: working newest-first leaves the
 * oldest unreviewed listing unreviewed forever. Verifying takes a row off the
 * list, which is what makes the count mean "outstanding" rather than "total".
 */
export function ModerationPage() {
  const queue = useModerationQueue();
  const verify = useVerifyListing();

  if (queue.isPending) return <QueueSkeleton />;

  const listings = queue.data ?? [];

  if (listings.length === 0) {
    return (
      <EmptyState
        illustration="rings"
        title="Nothing waiting"
        detail="Every published listing has been looked at. New ones appear here in the order they went live."
      />
    );
  }

  return (
    <>
      <p className="text-data text-ink-soft">{listings.length} waiting, oldest first.</p>
      <ul className="grid gap-2">
        {listings.map((listing) => (
          <ModerationRow
            key={listing.id}
            listing={listing}
            onVerify={() => {
              verify.mutate(
                { id: listing.id, isVerified: true },
                {
                  onSuccess: () => {
                    toast.success('Verified');
                  },
                  onError: () => {
                    toast.error('Could not verify that listing');
                  },
                },
              );
            }}
          />
        ))}
      </ul>
    </>
  );
}

const NEW_ACCOUNT_DAYS = 2;

function ModerationRow({ listing, onVerify }: { listing: AdminListing; onVerify: () => void }) {
  const price = listing.listingType === 'RENT' ? listing.rentAmount : listing.salePrice;

  // A brand-new account publishing immediately is the shape of a spam run, so
  // the moderator sees it without opening another page.
  const accountAgeDays = (Date.now() - new Date(listing.owner.memberSince).getTime()) / 86_400_000;
  const newAccount = accountAgeDays < NEW_ACCOUNT_DAYS;

  return (
    <li className="chrome flex flex-wrap items-center gap-3 p-3">
      <div className="size-16 shrink-0 overflow-hidden rounded-[var(--radius-inset)] bg-paper-sunken">
        {listing.coverUrl ? (
          <img src={listing.coverUrl} alt="" className="size-full object-cover" />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-label truncate">{listing.title ?? 'Untitled'}</p>
        <p className="text-data text-ink-soft">
          {[listing.locality, listing.cityName].filter(Boolean).join(' · ')} · {listing.imageCount}{' '}
          photo{listing.imageCount === 1 ? '' : 's'}
        </p>
        <p className="text-data text-ink-faint">
          {listing.owner.name} ({listing.owner.email})
          {newAccount ? (
            <span className="ml-1.5 text-clay">
              account is {Math.max(0, Math.round(accountAgeDays * 24))}h old
            </span>
          ) : null}
        </p>
      </div>

      <p className="text-price-lg shrink-0 text-signal-ink dark:text-signal">
        {formatRupees(price)}
      </p>

      <div className="flex shrink-0 gap-1">
        <Button asChild size="sm" variant="ghost">
          <Link to={`/listings/${listing.slug}`} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5" aria-hidden />
            Open
          </Link>
        </Button>
        <Button size="sm" onClick={onVerify}>
          <BadgeCheck className="size-3.5" aria-hidden />
          Verify
        </Button>
      </div>
    </li>
  );
}

/**
 * Unverify, offered where the verified listings are rather than in the queue.
 *
 * The queue holds only unverified rows by definition, so a toggle there would
 * be a button that removes the row it sits on and can never be pressed again.
 */
export function UnverifyButton({ id, onDone }: { id: string; onDone?: () => void }) {
  const verify = useVerifyListing();

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={verify.isPending}
      onClick={() => {
        verify.mutate(
          { id, isVerified: false },
          {
            onSuccess: () => {
              toast.success('Verification removed — it goes back in the queue');
              onDone?.();
            },
            onError: () => {
              toast.error('Could not change that listing');
            },
          },
        );
      }}
    >
      <ShieldOff className="size-3.5" aria-hidden />
      Unverify
    </Button>
  );
}

function QueueSkeleton() {
  return (
    <ul className="grid gap-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <li key={row} className="chrome flex items-center gap-3 p-3">
          <div className="size-16 shrink-0 animate-pulse rounded-[var(--radius-inset)] bg-paper-sunken" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-1/2 animate-pulse rounded-full bg-paper-sunken" />
            <div className="h-3 w-1/3 animate-pulse rounded-full bg-paper-sunken" />
          </div>
        </li>
      ))}
      <li className="sr-only" role="status">
        Loading the moderation queue…
      </li>
    </ul>
  );
}
