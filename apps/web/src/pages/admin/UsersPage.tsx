import type { AdminUser, UserRole } from '@machiya/shared';
import { USER_ROLES } from '@machiya/shared';
import { Ban, Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useAdminUserActions, useAdminUsers } from '../../hooks/use-admin';
import { useAuth } from '../../lib/auth-context';
import { useDebouncedValue } from '../../hooks/use-debounced-value';
import { cn } from '../../lib/utils';

/**
 * User management.
 *
 * The list comes from our API because the useful columns are ours — how many
 * listings someone owns, how many enquiries they are sitting on. The writes go
 * through Better Auth's admin plugin, which owns session revocation: a ban that
 * did not revoke the existing session would leave the banned account signed in
 * until the cookie expired.
 */
/**
 * What each role is called on screen. `SEEKER` is a column value, not a word
 * anyone says.
 */
const ROLE_LABELS: Record<(typeof USER_ROLES)[number], string> = {
  SEEKER: 'Renter',
  LISTER: 'Owner',
  ADMIN: 'Admin',
};

/** What the change lets them do, which is what the confirmation should say. */
const ROLE_ACTION: Record<(typeof USER_ROLES)[number], string> = {
  SEEKER: 'search and save places',
  LISTER: 'list properties',
  ADMIN: 'moderate everything',
};

export function UsersPage() {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 250);
  const users = useAdminUsers(debounced);

  return (
    <>
      <div className="grid gap-1.5">
        <label htmlFor="admin-user-search" className="text-label">
          Find someone
        </label>
        <Input
          id="admin-user-search"
          value={query}
          placeholder="Name or email"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>

      {users.isError ? (
        <LoadFailed what="the people list" onRetry={() => void users.refetch()} />
      ) : users.isPending ? (
        <UsersSkeleton />
      ) : (users.data ?? []).length === 0 ? (
        <EmptyState
          illustration="search"
          title="Nobody matches that"
          detail="Try part of an email address instead."
        />
      ) : (
        <ul className="grid gap-2">
          {(users.data ?? []).map((user) => (
            <UserRow key={user.id} user={user} />
          ))}
        </ul>
      )}
    </>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const { user: me } = useAuth();
  const { ban, unban, setRole } = useAdminUserActions();
  const [reason, setReason] = useState('');

  // Nobody may ban or demote themselves. It is the one action with no undo
  // available to the person taking it.
  const isSelf = me?.id === user.id;
  const busy = ban.isPending || unban.isPending || setRole.isPending;

  return (
    <li className="chrome flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <p className="text-label truncate">
          {user.name}
          {user.banned ? <span className="ml-1.5 text-clay">banned</span> : null}
          {user.emailVerified ? null : (
            <span className="ml-1.5 text-ink-faint">unverified email</span>
          )}
        </p>
        <p className="text-data truncate text-ink-soft">{user.email}</p>
        <p className="text-data text-ink-faint">
          {user.listingCount} listing{user.listingCount === 1 ? '' : 's'} · {user.enquiryCount}{' '}
          enquir{user.enquiryCount === 1 ? 'y' : 'ies'} · joined{' '}
          {new Date(user.createdAt).toLocaleDateString('en-IN')}
          {user.banReason ? ` · ${user.banReason}` : ''}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <label htmlFor={`role-${user.id}`} className="sr-only">
          Role for {user.name}
        </label>
        <select
          id={`role-${user.id}`}
          value={user.role}
          disabled={isSelf || busy}
          className={cn(
            'text-label rounded-[var(--radius-chrome)] border bg-transparent px-2 py-1',
            'disabled:opacity-50',
          )}
          onChange={(event) => {
            const nextRole = event.target.value as UserRole;
            setRole.mutate(
              { userId: user.id, role: nextRole },
              {
                onSuccess: () => {
                  toast.success(`${user.name} can now ${ROLE_ACTION[nextRole]}`);
                },
                onError: () => {
                  toast.error('That role did not change. Try again.');
                },
              },
            );
          }}
        >
          {USER_ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>

        {user.banned ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              unban.mutate(user.id, {
                onSuccess: () => {
                  toast.success('Unbanned');
                },
                onError: () => {
                  toast.error('Could not unban that account');
                },
              });
            }}
          >
            {unban.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            <ShieldCheck className="size-3.5" aria-hidden />
            Unban
          </Button>
        ) : (
          <>
            <label htmlFor={`ban-reason-${user.id}`} className="sr-only">
              Reason for banning {user.name}
            </label>
            <Input
              id={`ban-reason-${user.id}`}
              value={reason}
              placeholder="Why are you banning them?"
              className="h-8 w-32"
              disabled={isSelf}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              className="text-clay"
              // A ban with no reason is a ban nobody can review later.
              disabled={isSelf || busy || reason.trim().length < 3}
              onClick={() => {
                ban.mutate(
                  { userId: user.id, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      setReason('');
                      toast.success('Banned, and their sessions are revoked');
                    },
                    onError: () => {
                      toast.error('Could not ban that account');
                    },
                  },
                );
              }}
            >
              <Ban className="size-3.5" aria-hidden />
              Ban
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function UsersSkeleton() {
  return (
    <ul className="grid gap-2" aria-hidden>
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="chrome flex items-center gap-3 p-3">
          <div className="flex-1 space-y-2">
            <div className="h-4 w-1/3 animate-pulse rounded-full bg-paper-sunken" />
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-paper-sunken" />
          </div>
          <div className="h-8 w-40 animate-pulse rounded-full bg-paper-sunken" />
        </li>
      ))}
      <li className="sr-only" role="status">
        Loading users…
      </li>
    </ul>
  );
}
