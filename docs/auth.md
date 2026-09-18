# Auth

**Read this when** you are working on sessions, roles or guards — or you are
about to upgrade Better Auth.

Self-hosted [Better Auth](https://better-auth.com) on the Prisma adapter, mounted
at `/api/auth/*`. No hosted auth SaaS.

Sessions and an httpOnly cookie, not bearer tokens. Bans and mid-session role
upgrades both have to take effect on the next request, which a stateless token
cannot do (D93).

## Configuration

`apps/api/src/auth/index.ts` is the whole configuration. The pieces worth
knowing:

**Sessions live in Postgres, with Redis in front.** `secondaryStorage` alone
moves sessions into Redis **only** — and the Better Auth CLI then generates no
`Session` model at all, which is how this was noticed. That would mean a Redis
restart signs everybody out and no session is auditable or revocable from the
database. `session.storeSessionInDatabase: true` keeps the row in Postgres while
reads still come from Redis, which is what "database-backed sessions with cookie
caching" actually requires. Verified: after a sign-in
`SELECT count(*) FROM "Session"` returns the row, and sign-out removes it (D20).

**Email and password, with mandatory verification.** 10-character minimum,
one-hour token expiry. Verification and reset mail land in MailHog at
http://localhost:8025 in development.

**Google and GitHub are wired but conditional.** A provider is configured only
when it is BOTH listed in `AUTH_ENABLED_PROVIDERS` and supplied with a client id
and secret. Half-configured OAuth is worse than absent: the button renders and
then dies at the redirect. The web side reads `VITE_AUTH_PROVIDERS`, which must
match.

**The admin plugin** is mounted with `defaultRole: USER` and
`adminRoles: ['ADMIN']`, which is where the ban trio on `User` comes from.

**The openAPI plugin is development-only** (`...(isProduction ? [] : [openAPI()])`),
serving a route explorer at `/api/auth/reference`.

**Rate limiting counts in Redis**, so limits hold across API replicas. The whole
API has a blunt per-IP ceiling of 300/min; credential endpoints are an order of
magnitude harder — 5 sign-ins/min, 3 sign-ups per 5 min, 3 reset requests per
5 min.

## Two traps, both bitten and both now guarded

**The CLI lags the library.** `@better-auth/cli`'s newest release is 1.4.x while
`better-auth` is 1.7.x. The CLI generated an `Account` model with no `issuer`
column, which the 1.7 adapter writes — so every sign-up failed at runtime with
`Unknown argument 'issuer'`, with nothing at build time to catch it.

`pnpm auth:check` calls `getAuthTables(auth.options)` — the same definitions the
adapter writes through — and diffs them against `schema.prisma`, listing any
missing column. **It runs in CI.** Run it after every Better Auth upgrade or
plugin change. `pnpm auth:generate` is still the starting point, but its output
is a draft, not the truth (D22).

**Route names change.** 1.7 renamed `/forget-password` to
`/request-password-reset`. The old name in `rateLimit.customRules` matched
nothing and silently left the endpoint on the default limit — a rate-limit rule
that quietly does nothing is worse than no rule, because it reads as covered.
`pnpm auth:routes` prints the live route list from the openAPI plugin; check
custom rules against it after an upgrade (D23).

A third, smaller one: `sendVerificationEmail` receives a `url` whose
`callbackURL` defaults to the API's own `baseURL`, so a verified user landed on a
bare JSON host instead of the app. The handler must stay on the API — it consumes
the token — so the URL is rebuilt with `callbackURL` set to `WEB_APP_URL`, with
`url` kept as the fallback if the shape changes (D24).

## Roles and authorization

Three roles on the user record: `USER` (default), `EDITOR`, `ADMIN`.
Re-checked server-side on every request; never read from a request body.

| Guard                 | Rejects                                  | Notes                                                                                             |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `requireAuth`         | no session (401), banned account (403)   | Sets `req.auth`. Never reads ids from the body                                                    |
| `optionalAuth`        | nothing                                  | Attaches a session when present; a banned account is treated as anonymous                         |
| `requireRole(...)`    | wrong role (403)                         | **Admin always passes** — an admin is never locked out by omission                                |
| `requireMinRole(min)` | insufficient rank (403)                  | `EDITOR` admits `ADMIN` without naming it                                                         |
| `assertOwnership`     | a different user (403 `forbidden_owner`) | **Throws** rather than returning a boolean, so a forgotten `if` cannot silently authorise a write |

On its own, `requireRole` 401s rather than 403s — a route that forgot
`requireAuth` is a misconfiguration, and saying "forbidden" would imply the
session was checked.

**The guards take an injected session resolver.** `requireAuth(resolve)` is a
factory over a `SessionResolver`, not a module that imports the auth instance.
Two reasons: the guard tests need no cookies, database, Redis or auth provider —
they inject a fake resolver and assert on status codes — and swapping the auth
provider touches `apps/api/src/auth/session.ts` alone (D25).

`resolveSession` re-parses the role through the shared Zod enum rather than
casting it, so an unrecognised role **fails closed** with a log line naming the
user, instead of sliding through a `requireRole` check.

The web-side `RequireAuth` / `RequireRole` components decide what to _render_.
They are not a security boundary.

## Screens

`/auth/sign-in`, `/auth/sign-up`, `/auth/forgot-password`,
`/auth/reset-password`, `/auth/verify-email`.

A user who publishes a listing is upgraded to `EDITOR` **in the same
transaction as the publish**, so the two can never disagree.

## Tooling

```bash
pnpm auth:check      # does schema.prisma satisfy what Better Auth writes?
pnpm auth:generate   # regenerate the auth models (a draft — see D22)
BETTER_AUTH_URL=http://localhost:4000 pnpm auth:routes   # live route list
```

`auth:routes` needs the API running. `auth:check` needs only the schema and the
config.

## The admin plugin needs an access-control map, or it does nothing

`adminRoles: ['ADMIN']` gets a caller past the "is this an admin" gate. It is
**not** the permission check. Every admin endpoint then asks
`roles[session.role]` for a specific statement, and the plugin's built-in map
holds only `admin` and `user` — so with our role names the lookup missed and
`list-users`, `ban-user` and `set-role` all answered 403 while the config looked
correct.

The map lives in `@machiya/shared/auth-access` and is passed to **both** ends:
the server as `{ ac, roles }`, the browser client as `{ roles }` alone. Two
copies would let the runtime allow what the types forbade. Impersonation is
granted to nobody — the endpoint exists and answers 403, deliberately. See
[D70](../DECISIONS.md#d70-the-admin-plugin-was-mounted-and-inert-because-adminroles-is-not-the-permission-check).

Neither `auth:check` nor `auth:routes` catches this: the schema is right and the
routes exist. Only a live call does.

## After a Better Auth upgrade

1. `pnpm auth:generate`, then read the diff rather than trusting it.
2. `pnpm auth:check` — it is the check that catches what the CLI missed.
3. `pnpm auth:routes` and compare against `rateLimit.customRules`.
4. **Call three admin endpoints as an admin**, because nothing else catches a
   broken permission map:

   ```bash
   curl -sb cookies.txt -H 'origin: http://localhost:5173'      'http://localhost:4000/api/auth/admin/list-users?limit=1' -o /dev/null -w '%{http_code}
   ```

'

# ban-user and set-role the same way. 200 each, and 403 for impersonate-user.

```
5. Sign up, verify, sign in, reset a password, sign out. Confirm a `Session` row
appears in Postgres and disappears on sign-out.
6. `pnpm test` — the guard suite needs no infrastructure and runs in
milliseconds, and `@machiya/e2e` walks the credential path for real.
```
