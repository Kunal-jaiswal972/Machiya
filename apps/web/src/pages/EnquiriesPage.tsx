import type { EnquiryThread } from '@machiya/shared';
import { Loader2, Mail, Phone, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/ui/button';
import {
  useEnquiries,
  useEnquiry,
  useMarkEnquiryRead,
  useSendMessage,
} from '../hooks/use-enquiries';
import { formatRupees } from '../lib/format';
import { cn } from '../lib/utils';

type RoleFilter = 'all' | 'seeker' | 'lister';

/**
 * Enquiries, both sides of them.
 *
 * One screen rather than a lister inbox and a seeker inbox, because the same
 * person is often both — the seeker who found a flat is the lister who is
 * subletting their old one — and two inboxes would mean two unread badges to
 * check. The filter is there for when they want one side.
 */
export function EnquiriesPage() {
  const { id } = useParams<{ id?: string }>();
  const [role, setRole] = useState<RoleFilter>('all');

  const list = useEnquiries(role === 'all' ? undefined : role);
  const threads = list.data?.threads ?? [];

  return (
    <div className="mx-auto grid h-full w-full max-w-6xl gap-4 p-4 lg:grid-cols-[20rem_1fr]">
      <div className="flex min-h-0 flex-col gap-3">
        <div>
          <h1 className="text-title">Enquiries</h1>
          <p className="text-sm text-ink-soft">
            {list.data && list.data.unreadTotal > 0
              ? `${String(list.data.unreadTotal)} unread`
              : 'Conversations about listings'}
          </p>
        </div>

        <nav aria-label="Filter enquiries" className="flex gap-1.5">
          {(
            [
              { label: 'All', value: 'all' },
              { label: 'I asked', value: 'seeker' },
              { label: 'About mine', value: 'lister' },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={role === option.value}
              onClick={() => {
                setRole(option.value);
              }}
              className={cn(
                'text-label rounded-[var(--radius-chrome)] border px-2.5 py-1',
                role === option.value
                  ? 'border-water bg-water-soft'
                  : 'border-edge-strong text-ink-soft hover:bg-paper-sunken',
              )}
            >
              {option.label}
            </button>
          ))}
        </nav>

        {list.isPending ? (
          <ThreadSkeleton />
        ) : threads.length === 0 ? (
          <EmptyState
            illustration="thread"
            title="No conversations yet"
            detail={
              role === 'lister'
                ? 'When someone asks about one of your listings it lands here, and we email you the first time.'
                : 'Open a listing you like and send the owner a message — their number appears once you do.'
            }
            action={
              <Button asChild variant="secondary">
                <Link to="/">Back to the map</Link>
              </Button>
            }
          />
        ) : (
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} active={thread.id === id} />
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0">
        {id ? (
          <ThreadPanel enquiryId={id} />
        ) : (
          <div className="chrome flex h-full items-center justify-center">
            <EmptyState
              illustration="thread"
              title="Pick a conversation"
              detail="Contact details appear here once a conversation exists — that is what sending an enquiry unlocks."
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadRow({ thread, active }: { thread: EnquiryThread; active: boolean }) {
  const price =
    thread.listing.listingType === 'RENT' ? thread.listing.rentAmount : thread.listing.salePrice;

  return (
    <li>
      <Link
        to={`/enquiries/${thread.id}`}
        className={cn(
          'flex gap-2 rounded-[var(--radius-chrome)] border p-2',
          active ? 'border-water bg-water-soft' : 'border-transparent hover:bg-paper-sunken',
        )}
      >
        <div className="size-12 shrink-0 overflow-hidden rounded-[var(--radius-inset)] bg-paper-sunken">
          {thread.listing.coverUrl ? (
            <img src={thread.listing.coverUrl} alt="" className="size-full object-cover" />
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-label truncate">{thread.counterpart.name}</span>
            {thread.unreadCount > 0 ? (
              <span className="text-data shrink-0 rounded-full bg-signal px-1.5 text-signal-ink">
                {thread.unreadCount}
              </span>
            ) : null}
          </div>
          <p className="text-data truncate text-ink-soft">
            {thread.listing.title ?? 'Untitled'} · {formatRupees(price)}
          </p>
          {thread.preview ? (
            <p className="text-data truncate text-ink-faint">{thread.preview}</p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

function ThreadPanel({ enquiryId }: { enquiryId: string }) {
  const detail = useEnquiry(enquiryId);
  const send = useSendMessage(enquiryId);
  const markRead = useMarkEnquiryRead();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  const unread = detail.data?.thread.unreadCount ?? 0;

  // Opening a thread IS reading it. A separate "mark read" control would be a
  // second thing to remember for no benefit.
  useEffect(() => {
    if (unread > 0) markRead.mutate(enquiryId);
    // markRead is a stable mutation object; including it would re-fire the mark
    // on every render that changes anything else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enquiryId, unread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [detail.data?.messages.length]);

  if (detail.isPending) {
    return (
      <div className="chrome flex h-full items-center justify-center" role="status">
        <Loader2 className="size-5 animate-spin text-ink-faint" aria-hidden />
        <span className="sr-only">Loading the conversation…</span>
      </div>
    );
  }

  if (!detail.data) {
    return (
      <div className="chrome flex h-full items-center justify-center">
        <EmptyState illustration="thread" title="That conversation is not available" />
      </div>
    );
  }

  const { thread, messages } = detail.data;

  return (
    <div className="chrome flex h-full flex-col">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b p-3">
        <div className="min-w-0">
          <p className="text-label">{thread.counterpart.name}</p>
          <Link
            to={`/listings/${thread.listing.slug}`}
            className="text-data text-ink-soft hover:underline"
          >
            {thread.listing.title ?? 'Untitled'} · {thread.listing.locality}
          </Link>
        </div>

        {/* Visible because a thread exists. That IS the unmasking rule. */}
        <div className="text-data flex flex-wrap gap-3 text-ink-soft">
          {thread.counterpart.phone ? (
            <a href={`tel:${thread.counterpart.phone}`} className="flex items-center gap-1">
              <Phone className="size-3.5" aria-hidden />
              {thread.counterpart.phone}
            </a>
          ) : null}
          {thread.counterpart.email ? (
            <a href={`mailto:${thread.counterpart.email}`} className="flex items-center gap-1">
              <Mail className="size-3.5" aria-hidden />
              {thread.counterpart.email}
            </a>
          ) : null}
        </div>
      </header>

      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {messages.map((message) => (
          <li
            key={message.id}
            className={cn('flex', message.mine ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[42ch] rounded-[var(--radius-chrome)] px-2.5 py-1.5',
                message.mine ? 'bg-water-soft' : 'bg-paper-sunken',
              )}
            >
              <p className="text-sm whitespace-pre-line">{message.body}</p>
              <p className="text-data mt-0.5 text-ink-faint">
                {new Date(message.createdAt).toLocaleString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          </li>
        ))}
        <div ref={endRef} />
      </ol>

      <form
        className="flex gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const body = draft.trim();
          if (body.length < 2) return;

          send.mutate(
            { body },
            {
              onSuccess: () => {
                setDraft('');
              },
              onError: () => {
                toast.error('Could not send that — your message is still in the box');
              },
            },
          );
        }}
      >
        <label htmlFor="enquiry-reply" className="sr-only">
          Your message
        </label>
        <textarea
          id="enquiry-reply"
          value={draft}
          rows={2}
          placeholder="Write a reply"
          className="flex-1 resize-none rounded-[var(--radius-chrome)] border bg-transparent px-3 py-2 text-sm"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button type="submit" disabled={send.isPending || draft.trim().length < 2}>
          {send.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Send className="size-4" aria-hidden />
          )}
          <span className="sr-only">Send</span>
        </Button>
      </form>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <ul className="space-y-1.5" aria-hidden>
      {[0, 1, 2].map((row) => (
        <li key={row} className="flex gap-2 p-2">
          <div className="size-12 shrink-0 animate-pulse rounded-[var(--radius-inset)] bg-paper-sunken" />
          <div className="flex-1 space-y-1.5 py-1">
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-paper-sunken" />
            <div className="h-3 w-3/4 animate-pulse rounded-full bg-paper-sunken" />
          </div>
        </li>
      ))}
      <li className="sr-only" role="status">
        Loading your conversations…
      </li>
    </ul>
  );
}
