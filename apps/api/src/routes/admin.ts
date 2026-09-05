import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../lib/route-params.js';
import {
  requireAuth,
  requireRole,
  sessionOf,
  type SessionResolver,
} from '../middleware/require-auth.js';
import {
  coverageDemand,
  listUsers,
  moderationQueue,
  setListingVerified,
} from '../services/admin.js';

const usersQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const verifySchema = z.object({ isVerified: z.boolean() });

const moderationQuerySchema = z.object({
  /** Absent means the queue: the listings still waiting. */
  verified: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

/**
 * Admin. Two guards deep on purpose: `requireAuth` establishes the session and
 * `requireRole('ADMIN')` gates the router, and every service re-checks the role
 * anyway — a guard decides what renders, a service decides what happens.
 */
export function adminRouter(resolve: SessionResolver): Router {
  const router = Router();

  // Applied to the whole router rather than repeated per route: a new admin
  // endpoint added without its guard would otherwise be public, and that is
  // exactly the omission nobody notices in review.
  router.use('/admin', requireAuth(resolve), requireRole('ADMIN'));

  router.get('/admin/moderation', (req, res, next) => {
    const query = moderationQuerySchema.parse(req.query);
    moderationQueue(
      sessionOf(req),
      query.verified === undefined ? {} : { verified: query.verified },
    )
      .then((listings) => res.json({ listings }))
      .catch(next);
  });

  router.post('/admin/listings/:id/verify', (req, res, next) => {
    const { isVerified } = verifySchema.parse(req.body);
    setListingVerified(sessionOf(req), pathParam(req, 'id'), isVerified)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.get('/admin/users', (req, res, next) => {
    const query = usersQuerySchema.parse(req.query);
    listUsers(sessionOf(req), {
      ...(query.q ? { query: query.q } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    })
      .then((users) => res.json({ users }))
      .catch(next);
  });

  // The signal for which city to add fourth. See DECISIONS.md D55.
  router.get('/admin/coverage-demand', (req, res, next) => {
    coverageDemand(sessionOf(req))
      .then((demand) => res.json(demand))
      .catch(next);
  });

  return router;
}
