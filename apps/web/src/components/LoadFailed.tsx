import { RotateCw } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { Button } from './ui/button';

/**
 * "This did not load" — which is not the same statement as "there is nothing
 * here", and every list in the app was making the second one for both.
 *
 * A dropped request rendered "Nothing waiting — every published listing has
 * been looked at" to a moderator whose queue never arrived, and "Nothing saved
 * yet" to a seeker with twelve saved flats. Both are confident, both are wrong,
 * and neither offers a way to try again.
 *
 * One component so the distinction cannot be forgotten in the next list.
 */
export interface LoadFailedProps {
  /** What did not arrive, as a person would name it: "your saved places". */
  what: string;
  onRetry: () => void;
  className?: string;
}

export function LoadFailed({ what, onRetry, className }: LoadFailedProps) {
  return (
    <EmptyState
      illustration="search"
      title={`We could not load ${what}.`}
      detail="Nothing is lost — it is still there. This is usually a moment's connection trouble."
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCw aria-hidden />
          Try again
        </Button>
      }
      {...(className ? { className } : {})}
    />
  );
}
