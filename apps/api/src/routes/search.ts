import { parseSearchQuery, searchQueryToInput } from '@machiya/shared';
import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';
import { optionalAuth, type SessionResolver } from '../middleware/require-auth.js';
import { listAmenities } from '../services/amenities.js';
import { listCities, searchListings } from '../services/search.js';

/**
 * Radius search and the city list. Both public — someone picks an office and
 * searches before they sign in, and that is the product's first interaction.
 */
export function searchRouter(resolve: SessionResolver): Router {
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

  // Public: the wizard's checklist and the search's amenity filter read the
  // same list, and it changes only when someone re-seeds.
  router.get('/amenities', (_req, res, next) => {
    listAmenities()
      .then((groups) => {
        res.set('cache-control', 'public, max-age=300');
        res.json({ groups });
      })
      .catch(next);
  });

  /**
   * `optionalAuth` because the commute figures on every card come from the
   * caller's own stored preferences when they have any, and from the defaults
   * when they do not. A search must still work signed out.
   */
  router.get('/listings/search', optionalAuth(resolve), (req, res, next) => {
    const query = parseSearchQuery(req.query as Record<string, string | undefined>);
    const input = searchQueryToInput(query);

    if (!input) {
      // The whole search is anchored to a point. Without one there is nothing
      // to run, and an empty result would read as "no listings near you".
      next(new HttpError(400, 'office_required', 'Pick an office location first'));
      return;
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    searchListings(input, {
      ...(req.auth ? { session: req.auth } : {}),
      signal: controller.signal,
    })
      .then((result) => {
        // Not cacheable by a shared cache: the result set changes as listings
        // are published, and a stale count on a shared link is worse than a
        // round trip.
        //
        // Out of coverage is the exception and is cached an order of magnitude
        // longer — it changes only when a city is added, which changes the geo
        // epoch and every artifact with it. Still 200: "we do not serve that
        // city yet" is a complete answer, and the response is a discriminated
        // union so no caller can mistake it for an empty result set.
        res.set(
          'cache-control',
          result.status === 'ok' ? 'private, max-age=15' : 'public, max-age=600',
        );
        res.json(result);
      })
      .catch(next);
  });

  return router;
}
