import type { AdminListing } from '@machiya/shared';
import { BadgeCheck, ExternalLink, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { EmptyState } from '../../components/EmptyState';
import { Button } from '../../components/ui/button';
import { useModerationQueue, useVerifyListing } from '../../hooks/use-admin';
import { formatRupees } from '../../lib/format';
import { cn } from '../../lib/utils';

/**
 * Newly published listings, oldest first.
 *
 * Oldest first is the whole point of a queue: working newest-first leaves the
 * oldest unreviewed listing unreviewed forever. Verifying takes a row off the
 * list, which is what makes the count mean "outstanding" rather than "total".
 */
export function ModerationPage() {
  const [showVerified, setShowVerified] = useState(false);
  const queue = useModerationQueue(showVerified);
  const verify = useVerifyListing();

  const listings = queue.data ?? [];

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex gap-1.5">
          {(
            [
              { label: 'Waiting', value: false },
              { label: 'Verified', value: true },
            ] as const
          ).map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={showVerified === option.value}
              onClick={() => {
                setShowVerified(option.value);
              }}
              className={cn(
                'text-label rounded-[var(--radius-chrome)] border px-2.5 py-1',
                showVerified === option.value
                  ? 'border-water bg-water-soft'
                  : 'border-edge-strong text-ink-soft hover:bg-paper-sunken',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {queue.isPending ? null : (
          <p className="text-data text-ink-soft">
            {listings.length} {showVerified ? 'verified, newest first' : 'waiting, oldest first'}
          </p>
        )}
      </div>

      {queue.isPending ? (
        <QueueSkeleton />
      ) : listings.length === 0 ? (
        <EmptyState
          illustration="rings"
          title={showVerified ? 'Nothing verified yet' : 'Nothing waiting'}
          detail={
            showVerified
              ? 'Verified listings appear here, so a badge given by mistake can be taken back.'
              : 'Every published listing has been looked at. New ones appear here in the order they went live.'
          }
        />
      ) : (
        <ul className="grid gap-2">
          {listings.map((listing) => (
            <ModerationRow
              key={listing.id}
              listing={listing}
              action={
                listing.isVerified ? (
                  <UnverifyButton id={listing.id} />
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
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
                  >
                    <BadgeCheck className="size-3.5" aria-hidden />
                    Verify
                  </Button>
                )
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

const NEW_ACCOUNT_DAYS = 2;

function ModerationRow({ listing, action }: { listing: AdminListing; action: React.ReactNode }) {
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
        {action}
      </div>
    </li>
  );
}

/**
 * Unverify, offered on the verified list rather than in the queue.
 *
 * The queue holds only unverified rows, so a toggle there would be a button
 * that removes the row it sits on and can never be pressed again. Reachable
 * because the same endpoint serves both sides of `isVerified`.
 */
function UnverifyButton({ id, onDone }: { id: string; onDone?: () => void }) {
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
