import { createAccessControl, type AccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

/**
 * The Better Auth admin plugin's access control, in this product's role names.
 *
 * Shared because **both ends need the same definition and for different
 * reasons**. The server needs it or every admin endpoint answers 403: the
 * permission check resolves `roles[session.role]`, and the plugin's built-in
 * map holds only `admin` and `user`, so `ADMIN` misses and the answer is always
 * no. The browser client needs it or `authClient.admin.setRole` is typed to
 * `'admin' | 'user'` and will not accept a role this product actually has.
 *
 * Two copies would be the worst of both: the runtime would allow what the types
 * forbade, which is how you end up casting at the call site and losing the only
 * check there was.
 *
 * A **subpath** (`@machiya/shared/auth-access`) rather than the package index,
 * for the same reason as `@machiya/shared/images` and `/cities`: this module
 * reaches into `better-auth`, and neither the worker nor `packages/db` has any
 * business pulling that in.
 *
 * See DECISIONS.md D70 for the measurements.
 */
/**
 * Annotated rather than inferred, and that annotation is load-bearing.
 *
 * Without it the emitted `.d.ts` describes `ac` as an anonymous object shape,
 * and `adminPlugin`'s `AC extends AccessControl` parameter cannot be inferred
 * from it — so the same value that compiles inside this package fails to
 * compile at the consumer. Only visible once the definition crosses a package
 * boundary, which is exactly when it started failing.
 */
const ac: AccessControl<typeof defaultStatements> = createAccessControl(defaultStatements);

/**
 * Impersonation is deliberately granted to nobody.
 *
 * The plugin ships `/admin/impersonate-user`, and it lets an operator read
 * somebody's private enquiries as them. Nothing in this product needs it, and
 * an unused permission is one nobody is watching — so the statement is left out
 * of every role rather than granted and un-exercised. Verified: the endpoint
 * answers 403 "You are not allowed to impersonate users".
 */
const ADMIN_STATEMENTS = {
  user: [
    'create',
    'list',
    'set-role',
    'ban',
    'delete',
    'set-password',
    'set-email',
    'get',
    'update',
  ],
  session: ['list', 'revoke', 'delete'],
} as const;

/** A seeker and a lister manage listings, not people. Neither gets a statement. */
const NO_STATEMENTS = { user: [], session: [] } as const;

export const roles = {
  USER: ac.newRole(NO_STATEMENTS),
  EDITOR: ac.newRole(NO_STATEMENTS),
  ADMIN: ac.newRole(ADMIN_STATEMENTS),
};

export { ac };
