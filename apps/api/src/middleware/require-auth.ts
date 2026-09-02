import {
  canMutateOwnedResource,
  hasAtLeastRole,
  isAdmin,
  type SessionUser,
  type UserRole,
} from '@machiya/shared';
import type { Request, RequestHandler } from 'express';
import { logger } from '../logger.js';
import { HttpError } from './error-handler.js';

export interface RequestSession {
  userId: string;
  role: UserRole;
  user: SessionUser;
}

/**
 * How a request is turned into a session. Injected rather than imported so the
 * guards can be tested without Better Auth, a database or a live cookie — and
 * so swapping the auth provider touches one adapter, not every route.
 */
export type SessionResolver = (req: Request) => Promise<RequestSession | null>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. Absent on unauthenticated routes. */
      auth?: RequestSession;
    }
  }
}

/**
 * Rejects anything without a valid session, and anything belonging to a banned
 * account. Never reads a user id, role or owner id from the request — those are
 * client-supplied hints and carry no authority.
 */
export function requireAuth(resolve: SessionResolver): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const session = await resolve(req);

        if (!session) {
          next(new HttpError(401, 'unauthenticated', 'Sign in to continue'));
          return;
        }

        if (session.user.banned) {
          next(new HttpError(403, 'account_suspended', 'This account has been suspended'));
          return;
        }

        req.auth = session;
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * Attaches a session when one is present and does nothing when it is not.
 *
 * For routes that are public but read differently when signed in — a listing
 * detail page shows the owner their own draft, and 404s for everyone else.
 */
export function optionalAuth(resolve: SessionResolver): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const session = await resolve(req);

        // A banned account is treated as anonymous rather than rejected: these
        // routes are readable without any session at all.
        if (session && !session.user.banned) {
          req.auth = session;
        }
      } catch (error) {
        // A failure to read an optional session must not fail a public request.
        logger.warn({ err: error }, 'optional session lookup failed');
      }

      next();
    })();
  };
}

/**
 * Exact-role gate, with an admin override — an admin is never locked out of a
 * route by omission. Layer it on top of requireAuth; on its own it 401s.
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const session = req.auth;

    if (!session) {
      next(new HttpError(401, 'unauthenticated', 'Sign in to continue'));
      return;
    }

    if (isAdmin(session.role) || roles.includes(session.role)) {
      next();
      return;
    }

    next(new HttpError(403, 'forbidden_role', `This action needs one of: ${roles.join(', ')}`));
  };
}

/** Rank-based variant: LISTER also admits ADMIN without naming it. */
export function requireMinRole(minimum: UserRole): RequestHandler {
  return (req, _res, next) => {
    const session = req.auth;

    if (!session) {
      next(new HttpError(401, 'unauthenticated', 'Sign in to continue'));
      return;
    }

    if (hasAtLeastRole(session.role, minimum)) {
      next();
      return;
    }

    next(new HttpError(403, 'forbidden_role', `This action needs at least ${minimum}`));
  };
}

/**
 * Ownership re-check for every listing, image and enquiry mutation. Admins pass.
 * Throws rather than returning a boolean so a forgotten `if` cannot silently
 * authorise the write.
 */
export function assertOwnership(session: RequestSession, resourceOwnerId: string): void {
  if (!canMutateOwnedResource({ userId: session.userId, role: session.role }, resourceOwnerId)) {
    throw new HttpError(403, 'forbidden_owner', 'This is not yours to change');
  }
}

/** Reads the session a guard already established, or fails loudly. */
export function sessionOf(req: Request): RequestSession {
  if (!req.auth) {
    throw new HttpError(500, 'internal_error', 'Route is missing requireAuth');
  }
  return req.auth;
}
