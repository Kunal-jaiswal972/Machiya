import { Router } from 'express';
import { pathParam } from '../lib/route-params.js';
import { requireAuth, sessionOf, type SessionResolver } from '../middleware/require-auth.js';
import { createOffice, deleteOffice, listOffices, patchOffice } from '../services/offices.js';

/**
 * Saved offices. Every route is authenticated and scoped to the session user —
 * an office is somebody's workplace address, so there is no public read and no
 * admin override.
 */
export function officesRouter(resolve: SessionResolver): Router {
  const router = Router();
  const authed = requireAuth(resolve);

  router.get('/offices', authed, (req, res, next) => {
    listOffices(sessionOf(req))
      .then((result) => res.json(result))
      .catch(next);
  });

  router.post('/offices', authed, (req, res, next) => {
    createOffice(sessionOf(req), req.body)
      .then((office) => res.status(201).json({ office }))
      .catch(next);
  });

  router.patch('/offices/:id', authed, (req, res, next) => {
    patchOffice(sessionOf(req), pathParam(req, 'id'), req.body)
      .then((office) => res.json({ office }))
      .catch(next);
  });

  router.delete('/offices/:id', authed, (req, res, next) => {
    deleteOffice(sessionOf(req), pathParam(req, 'id'))
      .then((result) => res.json(result))
      .catch(next);
  });

  return router;
}
