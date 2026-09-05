import { AUTH_ERROR_MESSAGES, AuthError } from '@machiya/shared';
import { CircleUser } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { auth } from '../../lib/auth-client';
import { useAuth } from '../../lib/auth-context';
import { Button } from '../ui/button';

export function UserMenu() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);

  if (isLoading) {
    return <div className="h-8 w-24 animate-pulse rounded-md bg-muted" aria-hidden />;
  }

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/auth/sign-in">Sign in</Link>
        </Button>
        <Button asChild size="sm">
          <Link to="/auth/sign-up">Sign up</Link>
        </Button>
      </div>
    );
  }

  async function signOut() {
    setIsSigningOut(true);
    try {
      await auth.signOut();
      await navigate('/', { replace: true });
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'unknown';
      toast.error(AUTH_ERROR_MESSAGES[code]);
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {/* The name IS the way into the account — it was plain text, so the
          account page had no entrance from anywhere in the product. The icon
          carries it below `sm`, where the name is hidden. */}
      <Link
        to="/account"
        className="hidden text-xs text-ink-soft hover:text-ink hover:underline underline-offset-4 sm:inline"
      >
        {user.name} · {user.role.toLowerCase()}
      </Link>

      <Button variant="ghost" size="icon" asChild className="sm:hidden">
        <Link to="/account">
          <CircleUser aria-hidden />
          <span className="sr-only">Your account</span>
        </Link>
      </Button>

      {/* Offered to a SEEKER too, because publishing is what makes someone a
          lister — gating the entrance on the role they earn by walking through
          it is backwards. */}
      <Button variant="ghost" size="sm" asChild>
        <Link to="/lister">Listings</Link>
      </Button>
      <Button variant="ghost" size="sm" asChild>
        <Link to="/saved">Saved</Link>
      </Button>
      <Button variant="ghost" size="sm" asChild>
        <Link to="/enquiries">Enquiries</Link>
      </Button>
      {user.role === 'ADMIN' ? (
        <Button variant="ghost" size="sm" asChild>
          <Link to="/admin">Admin</Link>
        </Button>
      ) : null}

      <Button variant="outline" size="sm" disabled={isSigningOut} onClick={() => void signOut()}>
        {isSigningOut ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  );
}
