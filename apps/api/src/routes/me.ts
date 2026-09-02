import { sessionUserSchema } from '@machiya/shared';
import { Router } from 'express';
import { requireAuth, sessionOf, type SessionResolver } from '../middleware/require-auth.js';

/**
 * The signed-in user as the server sees them.
 *
 * The browser gets its session from the auth client, so this exists to give the
 * app one authoritative read of role and verification state — and to make the
 * guard chain observable from a terminal.
 */
export function meRouter(resolve: SessionResolver): Router {
  const router = Router();

  router.get('/me', requireAuth(resolve), (req, res) => {
    res.json({ user: sessionUserSchema.parse(sessionOf(req).user) });
  });

  return router;
}
