import { hasAtLeastRole, userRoleSchema, type SessionUser, type UserRole } from '@machiya/shared';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSession } from './auth-client';

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  isSignedIn: boolean;
  role: UserRole | null;
  /** True when the signed-in user's rank meets or exceeds `minimum`. */
  can: (minimum: UserRole) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * One subscription to the session for the whole app.
 *
 * Calling `useSession` in every component would mean every component
 * re-fetching and re-rendering independently; this hoists it once.
 *
 * The role is re-parsed through the shared enum rather than cast: it arrives as
 * a plain string, and an unrecognised value must read as "no role" instead of
 * quietly passing a UI-level check. The server re-checks regardless — nothing
 * here is an authorisation decision, only what to render.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession();

  const value = useMemo<AuthContextValue>(() => {
    const raw = data?.user;
    const parsedRole = raw ? userRoleSchema.safeParse(raw.role) : null;
    const role = parsedRole?.success ? parsedRole.data : null;

    const user: SessionUser | null =
      raw && role
        ? {
            id: raw.id,
            email: raw.email,
            name: raw.name,
            emailVerified: raw.emailVerified,
            role,
            avatarUrl: raw.image ?? null,
            banned: raw.banned ?? false,
          }
        : null;

    return {
      user,
      isLoading: isPending,
      isSignedIn: user !== null,
      role,
      can: (minimum) => (role ? hasAtLeastRole(role, minimum) : false),
    };
  }, [data, isPending]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Provider and hook belong in one file — splitting them to satisfy fast refresh
// would leave the context object exported from somewhere neither of them lives.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }

  return context;
}
