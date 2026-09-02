import { userRoleSchema, type SessionUser } from '@machiya/shared';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { logger } from '../logger.js';
import type { RequestSession, SessionResolver } from '../middleware/require-auth.js';
import { auth } from './index.js';

/**
 * The one place a Better Auth session becomes an application session.
 *
 * The role is re-parsed through the shared enum rather than trusted: it arrives
 * as a plain string from the auth layer, and an unrecognised value must fail
 * closed instead of sliding through an authorisation check.
 */
export const resolveSession: SessionResolver = async (
  req: Request,
): Promise<RequestSession | null> => {
  const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  if (!result?.user) {
    return null;
  }

  const role = userRoleSchema.safeParse(result.user.role);

  if (!role.success) {
    logger.error(
      { userId: result.user.id, role: result.user.role },
      'session carries an unrecognised role — refusing it',
    );
    return null;
  }

  const user: SessionUser = {
    id: result.user.id,
    email: result.user.email,
    name: result.user.name,
    emailVerified: result.user.emailVerified,
    role: role.data,
    avatarUrl: result.user.image ?? null,
    phone: result.user.phone ?? null,
    isPhoneVerified: result.user.isPhoneVerified ?? false,
    banned: result.user.banned ?? false,
  };

  return { userId: user.id, role: role.data, user };
};
