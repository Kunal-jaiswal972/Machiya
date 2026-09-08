import type { SessionUser, UserRole } from '@machiya/shared';
import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/error-handler.js';
import {
  assertOwnership,
  requireAuth,
  requireMinRole,
  requireRole,
  sessionOf,
  type RequestSession,
  type SessionResolver,
} from '../src/middleware/require-auth.js';

function sessionFor(role: UserRole, overrides: Partial<SessionUser> = {}): RequestSession {
  const user: SessionUser = {
    id: `user-${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@test.local`,
    name: role,
    emailVerified: true,
    role,
    banned: false,
    ...overrides,
  };
  return { userId: user.id, role, user };
}

const anonymous: SessionResolver = async () => null;
const asRole =
  (role: UserRole, overrides?: Partial<SessionUser>): SessionResolver =>
  async () =>
    sessionFor(role, overrides);

/**
 * A throwaway app with the guard chain and nothing else, so a failure points at
 * the middleware rather than at whatever route happened to be behind it.
 */
function guardedApp(resolve: SessionResolver): Express {
  const app = express();
  app.use(express.json());

  app.get('/protected', requireAuth(resolve), (req, res) => {
    res.json({ userId: sessionOf(req).userId });
  });

  app.get('/lister-only', requireAuth(resolve), requireRole('EDITOR'), (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/admin-only', requireAuth(resolve), requireRole('ADMIN'), (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/at-least-lister', requireAuth(resolve), requireMinRole('EDITOR'), (_req, res) => {
    res.json({ ok: true });
  });

  // Stands in for every listing, image and enquiry mutation: the owner id comes
  // from stored data, never from the request.
  app.patch('/listings/:ownerId', requireAuth(resolve), (req, res) => {
    assertOwnership(sessionOf(req), req.params.ownerId as string);
    res.json({ ok: true });
  });

  // No requireAuth in front — a route wired wrongly must fail loudly.
  app.get('/misconfigured', requireRole('EDITOR'), (_req, res) => {
    res.json({ ok: true });
  });

  app.use(errorHandler);
  return app;
}

describe('requireAuth', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const response = await request(guardedApp(anonymous)).get('/protected');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthenticated');
  });

  it('admits a valid session and exposes it to the handler', async () => {
    const response = await request(guardedApp(asRole('USER'))).get('/protected');

    expect(response.status).toBe(200);
    expect(response.body.userId).toBe('user-user');
  });

  it('rejects a banned account with 403 even though the session is valid', async () => {
    const response = await request(guardedApp(asRole('EDITOR', { banned: true }))).get(
      '/protected',
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('account_suspended');
  });

  it('surfaces a resolver failure as a 500, not as an open door', async () => {
    const broken: SessionResolver = async () => {
      throw new Error('session store unreachable');
    };

    const response = await request(guardedApp(broken)).get('/protected');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('internal_error');
  });
});

describe('requireRole', () => {
  it('rejects the wrong role with 403', async () => {
    const response = await request(guardedApp(asRole('USER'))).get('/lister-only');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden_role');
  });

  it('admits the named role', async () => {
    const response = await request(guardedApp(asRole('EDITOR'))).get('/lister-only');
    expect(response.status).toBe(200);
  });

  it('admits an admin to a route that does not name ADMIN', async () => {
    const response = await request(guardedApp(asRole('ADMIN'))).get('/lister-only');
    expect(response.status).toBe(200);
  });

  it('still rejects a lister from an admin-only route', async () => {
    const response = await request(guardedApp(asRole('EDITOR'))).get('/admin-only');
    expect(response.status).toBe(403);
  });

  it('401s rather than 403s when requireAuth was never mounted', async () => {
    const response = await request(guardedApp(asRole('ADMIN'))).get('/misconfigured');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthenticated');
  });
});

describe('requireMinRole', () => {
  it('admits equal and higher ranks and rejects lower ones', async () => {
    const seeker = await request(guardedApp(asRole('USER'))).get('/at-least-lister');
    const lister = await request(guardedApp(asRole('EDITOR'))).get('/at-least-lister');
    const admin = await request(guardedApp(asRole('ADMIN'))).get('/at-least-lister');

    expect(seeker.status).toBe(403);
    expect(lister.status).toBe(200);
    expect(admin.status).toBe(200);
  });
});

describe('assertOwnership', () => {
  it('lets an owner change their own resource', async () => {
    const response = await request(guardedApp(asRole('EDITOR'))).patch('/listings/user-editor');
    expect(response.status).toBe(200);
  });

  it('rejects a different signed-in user with 403', async () => {
    const response = await request(guardedApp(asRole('EDITOR'))).patch('/listings/someone-else');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden_owner');
  });

  it('lets an admin override ownership', async () => {
    const response = await request(guardedApp(asRole('ADMIN'))).patch('/listings/someone-else');
    expect(response.status).toBe(200);
  });

  it('does not treat a matching id from a lower role as authority on its own', async () => {
    // A seeker owning the row is still the owner: role does not gate ownership.
    const response = await request(guardedApp(asRole('USER'))).patch('/listings/user-user');
    expect(response.status).toBe(200);
  });
});
