import { parseSearchQuery, searchQueryToInput } from '@machiya/shared';
import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';
import { listCities, searchListings } from '../services/search.js';

/**
 * Radius search and the city list. Both public — someone picks an office and
 * searches before they sign in, and that is the product's first interaction.
 */
export function searchRouter(): Router {
  const router = Router();

  router.get('/cities', (_req, res, next) => {
    listCities()
      .then((cities) => {
        // Three rows that change only when someone re-seeds.
        res.set('cache-control', 'public, max-age=300');
        res.json({ cities });
      })
      .catch(next);
  });

  router.get('/listings/search', (req, res, next) => {
    const query = parseSearchQuery(req.query as Record<string, string | undefined>);
    const input = searchQueryToInput(query);

    if (!input) {
      // The whole search is anchored to a point. Without one there is nothing
      // to run, and an empty result would read as "no listings near you".
      next(new HttpError(400, 'office_required', 'Pick an office location first'));
      return;
    }

    searchListings(input)
      .then((result) => {
        // Not cacheable by a shared cache: the result set changes as listings
        // are published, and a stale count on a shared link is worse than a
        // round trip.
        res.set('cache-control', 'private, max-age=15');
        res.json(result);
      })
      .catch(next);
  });

  return router;
}
