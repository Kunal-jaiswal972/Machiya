import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router';
import { ApiRequestError } from '../lib/api';
import { Button } from './ui/button';

/**
 * Per-route error boundary with a retry (docs/design.md).
 *
 * The retry re-runs THIS route, not a page reload: reloading throws away the
 * search state the user built up, and the whole point of putting that state in
 * the URL was that it survives.
 *
 * Errors say what happened and what to do about it. They do not apologise and
 * they are never vague — "something went wrong" tells a user nothing they can
 * act on.
 */
function describe(error: unknown): { title: string; detail: string } {
  if (error instanceof ApiRequestError) {
    if (error.status === 404) {
      return {
        title: 'That listing is not here',
        detail: 'It may have been unpublished or removed. Search again to see what is available.',
      };
    }
    if (error.status === 401) {
      return { title: 'Sign in to see this', detail: 'This page needs an account.' };
    }
    if (error.status === 403) {
      return { title: 'Not yours to open', detail: 'This belongs to another account.' };
    }
    if (error.status === 429) {
      return {
        title: 'Too many requests',
        detail: 'Wait a few seconds and try again.',
      };
    }
    if (error.status >= 500) {
      return {
        title: 'The server could not answer',
        detail: 'Nothing was lost — try again in a moment.',
      };
    }
    return { title: 'That request was refused', detail: error.message };
  }

  if (isRouteErrorResponse(error)) {
    return {
      title: error.status === 404 ? 'No such page' : 'That page could not load',
      detail: error.statusText || 'Try again, or go back to the search.',
    };
  }

  if (error instanceof Error && error.message.toLowerCase().includes('fetch')) {
    return {
      title: 'No connection to the server',
      detail: 'Check the network. The API runs on port 4000 in development.',
    };
  }

  return {
    title: 'This view could not load',
    detail: 'Retrying usually clears it. If it does not, the console has the detail.',
  };
}

export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const { title, detail } = describe(error);

  return (
    <div role="alert" className="flex h-full items-center justify-center p-6">
      <div className="chrome flex max-w-md flex-col items-start gap-3 p-5">
        {/* A hairline in `clay` rather than a full red panel: something failed,
            the app has not. */}
        <div className="h-0.5 w-10 rounded-round bg-clay" />
        <h1 className="text-title">{title}</h1>
        <p className="text-sm text-ink-soft">{detail}</p>
        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => {
              // Re-runs this route's loaders and queries. Not location.reload().
              void navigate('.', { replace: true });
            }}
          >
            Try again
          </Button>
          <Button variant="ghost" onClick={() => void navigate('/')}>
            Back to search
          </Button>
        </div>
      </div>
    </div>
  );
}
