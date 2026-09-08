import { userRoleSchema, type UserRole } from '../enums.js';

/**
 * Roles, ordered. A higher rank implies every capability of the ranks below it,
 * which is what `hasAtLeastRole` encodes — so a route guarded for EDITOR also
 * admits ADMIN without listing it everywhere.
 */
const ROLE_RANK: Record<UserRole, number> = {
  USER: 0,
  EDITOR: 1,
  ADMIN: 2,
};

export const DEFAULT_ROLE: UserRole = 'USER';
export const ADMIN_ROLES: readonly UserRole[] = ['ADMIN'];

export { userRoleSchema, type UserRole };

export function hasAtLeastRole(role: UserRole, minimum: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function isAdmin(role: UserRole): boolean {
  return role === 'ADMIN';
}

/**
 * Ownership check used by every listing, image and enquiry mutation.
 *
 * Deliberately takes the session role and id rather than anything the client
 * sent: the owner id in a request body is a hint, never an authorisation.
 */
export function canMutateOwnedResource(
  session: { userId: string; role: UserRole },
  resourceOwnerId: string,
): boolean {
  return isAdmin(session.role) || session.userId === resourceOwnerId;
}
