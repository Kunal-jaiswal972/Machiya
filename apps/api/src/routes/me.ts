import { Router } from 'express';
import { requireAuth, sessionOf, type SessionResolver } from '../middleware/require-auth.js';
import {
  deleteAccount,
  getProfile,
  getUiPreferences,
  updateProfile,
  updateUiPreferences,
} from '../services/account.js';

/**
 * The signed-in user as the server sees them, and the two things they can do
 * to their own account.
 *
 * The browser gets its session from the auth client, so the read exists to give
 * the app one authoritative view of role and verification state — and to make
 * the guard chain observable from a terminal.
 */
export function meRouter(resolve: SessionResolver): Router {
  const router = Router();

  router.get('/me', requireAuth(resolve), (req, res, next) => {
    getProfile(sessionOf(req))
      .then((result) => res.json(result))
      .catch(next);
  });

  router.patch('/me', requireAuth(resolve), (req, res, next) => {
    updateProfile(sessionOf(req), req.body)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.get('/me/preferences', requireAuth(resolve), (req, res, next) => {
    getUiPreferences(sessionOf(req))
      .then((preferences) => res.json({ preferences }))
      .catch(next);
  });

  router.patch('/me/preferences', requireAuth(resolve), (req, res, next) => {
    updateUiPreferences(sessionOf(req), req.body)
      .then((preferences) => res.json({ preferences }))
      .catch(next);
  });

  router.delete('/me', requireAuth(resolve), (req, res, next) => {
    deleteAccount(sessionOf(req))
      .then((result) => res.json(result))
      .catch(next);
  });

  return router;
}
