import { Loader2, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useStartEnquiry } from '../../hooks/use-enquiries';
import { useAuth } from '../../lib/auth-context';
import { Button } from '../ui/button';

/**
 * "Ask the owner", and the moment their number stops being masked.
 *
 * Three states rather than one form with conditionals, because they are three
 * different things to say:
 *
 *  - **not signed in** — an enquiry is a message from a named person to a named
 *    person, so it cannot be anonymous. The link carries the return path.
 *  - **already talking** — the thread exists, so the form would be a second
 *    place to write in. Link to the one that has the history.
 *  - **the first message** — a box, with copy that says what sending does.
 */
export function EnquiryForm({
  listingSlug,
  ownerName,
  viewerIsOwner,
  viewerHasEnquired,
}: {
  listingSlug: string;
  ownerName: string;
  viewerIsOwner: boolean;
  viewerHasEnquired: boolean;
}) {
  const { isSignedIn } = useAuth();
  const navigate = useNavigate();
  const start = useStartEnquiry(listingSlug);
  const [body, setBody] = useState('');

  // Nothing to offer: a conversation with yourself is not a feature.
  if (viewerIsOwner) return null;

  if (!isSignedIn) {
    return (
      <section className="rounded-chrome border border-edge p-3">
        <p className="text-sm text-ink-soft">
          Sign in to message {ownerName}. Their phone number appears as soon as you do.
        </p>
        <Button asChild size="sm" className="mt-2">
          <Link to="/auth/sign-in" state={{ from: `/listings/${listingSlug}` }}>
            Sign in to enquire
          </Link>
        </Button>
      </section>
    );
  }

  if (viewerHasEnquired) {
    return (
      <section className="rounded-chrome border border-edge p-3">
        <p className="text-sm text-ink-soft">You have a conversation open about this place.</p>
        <Button asChild size="sm" variant="secondary" className="mt-2">
          <Link to="/enquiries">
            <MessageSquare className="size-3.5" aria-hidden />
            Open it
          </Link>
        </Button>
      </section>
    );
  }

  return (
    <form
      className="rounded-chrome border border-edge p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const text = body.trim();
        if (text.length < 2) return;

        start.mutate(
          { body: text },
          {
            onSuccess: (result) => {
              setBody('');
              toast.success(`Sent to ${ownerName}. Their contact details are on the thread.`);
              void navigate(`/enquiries/${result.enquiryId}`);
            },
            onError: () => {
              toast.error('Could not send that — your message is still in the box');
            },
          },
        );
      }}
    >
      <label htmlFor="enquiry-body" className="text-label">
        Ask {ownerName}
      </label>
      <textarea
        id="enquiry-body"
        value={body}
        rows={3}
        placeholder="Is it still available, and when could I see it?"
        className="mt-1.5 w-full resize-none rounded-[var(--radius-chrome)] border bg-transparent px-3 py-2 text-sm"
        onChange={(event) => {
          setBody(event.target.value);
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-data text-ink-faint">
          Sending swaps the mask for their number, both ways.
        </p>
        <Button type="submit" size="sm" disabled={start.isPending || body.trim().length < 2}>
          {start.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Send
        </Button>
      </div>
    </form>
  );
}
