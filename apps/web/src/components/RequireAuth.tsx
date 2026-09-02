import type { UserRole } from '@machiya/shared';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../lib/auth-context';

function Waiting() {
  return (
    <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
      <span className="sr-only">Checking your session…</span>
    </div>
  );
}

/**
 * Route guard. Convenience only — it decides what to RENDER, never what is
 * allowed: every protected read and write is re-checked server-side against the
 * session, because anything in this bundle is under the user's control.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <Waiting />;

  if (!isSignedIn) {
    // Carry the attempted path so sign-in can return the user to it.
    return <Navigate to="/auth/sign-in" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

export function RequireRole({ minimum, children }: { minimum: UserRole; children: ReactNode }) {
  const { isSignedIn, isLoading, can } = useAuth();
  const location = useLocation();

  if (isLoading) return <Waiting />;

  if (!isSignedIn) {
    return <Navigate to="/auth/sign-in" replace state={{ from: location.pathname }} />;
  }

  if (!can(minimum)) {
    return <Navigate to="/forbidden" replace />;
  }

  return <>{children}</>;
}
