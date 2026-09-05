import { Router } from 'express';
import { pathParam } from '../lib/route-params.js';
import { requireAuth, sessionOf, type SessionResolver } from '../middleware/require-auth.js';
import {
  addFavorite,
  createSavedSearch,
  deleteSavedSearch,
  favoriteIds,
  listFavorites,
  listSavedSearches,
  removeFavorite,
  updateSavedSearch,
} from '../services/seeker.js';

/**
 * Favorites and saved searches. Both are one person's private shelf, so every
 * route is authenticated and scoped to the session user with no admin override
 * — an admin has no business reading what somebody bookmarked.
 */
export function seekerRouter(resolve: SessionResolver): Router {
  const router = Router();
  const authed = requireAuth(resolve);

  router.get('/favorites', authed, (req, res, next) => {
    listFavorites(sessionOf(req))
      .then((favorites) => res.json({ favorites }))
      .catch(next);
  });

  // Ids only, so the heart on every result card costs one request rather than
  // one per card.
  router.get('/favorites/ids', authed, (req, res, next) => {
    favoriteIds(sessionOf(req))
      .then((listingIds) => res.json({ listingIds }))
      .catch(next);
  });

  router.put('/favorites/:listingId', authed, (req, res, next) => {
    addFavorite(sessionOf(req), pathParam(req, 'listingId'))
      .then((result) => res.json(result))
      .catch(next);
  });

  router.delete('/favorites/:listingId', authed, (req, res, next) => {
    removeFavorite(sessionOf(req), pathParam(req, 'listingId'))
      .then((result) => res.json(result))
      .catch(next);
  });

  router.get('/saved-searches', authed, (req, res, next) => {
    listSavedSearches(sessionOf(req))
      .then((searches) => res.json({ searches }))
      .catch(next);
  });

  router.post('/saved-searches', authed, (req, res, next) => {
    createSavedSearch(sessionOf(req), req.body)
      .then((saved) => res.status(201).json(saved))
      .catch(next);
  });

  router.patch('/saved-searches/:id', authed, (req, res, next) => {
    updateSavedSearch(sessionOf(req), pathParam(req, 'id'), req.body)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.delete('/saved-searches/:id', authed, (req, res, next) => {
    deleteSavedSearch(sessionOf(req), pathParam(req, 'id'))
      .then((result) => res.json(result))
      .catch(next);
  });

  return router;
}
