import { coordinateSchema, placeSearchQuerySchema } from '@machiya/shared';
import { Router } from 'express';
import { z } from 'zod';
import { reversePlace, suggestPlaces } from '../services/places.js';

const reverseQuerySchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
});

/**
 * Place lookup for office selection: type-ahead and reverse geocoding.
 *
 * Public — an anonymous visitor picks an office before signing in, and that is
 * the product's first interaction. Both routes are bounded by the API's per-IP
 * rate limit, and the expensive half (tier 2) is Redis-cached for a week and
 * only reached when the local tier came up short.
 */
export function placesRouter(): Router {
  const router = Router();

  router.get('/places/suggest', (req, res, next) => {
    const query = placeSearchQuerySchema.parse(req.query);

    // A browser that abandons the request — the user kept typing — aborts the
    // upstream call too, so a cancelled keystroke does not keep a Nominatim
    // request alive to no purpose.
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    suggestPlaces(query, { signal: controller.signal })
      .then((result) => {
        // Suggestions for one query are stable for a while and are not
        // user-specific, so let the browser and any shared cache help.
        res.set('cache-control', 'public, max-age=60');
        res.json(result);
      })
      .catch(next);
  });

  router.get('/places/reverse', (req, res, next) => {
    const { lat, lng } = reverseQuerySchema.parse(req.query);
    const coordinate = coordinateSchema.parse({ lat, lng });

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    reversePlace(coordinate, { signal: controller.signal })
      .then((place) => {
        res.set('cache-control', 'public, max-age=300');
        // 200 with a null place, not 404: "there is no address at this point"
        // is a successful answer about a legitimate coordinate. The client
        // shows the coordinates instead of an error.
        res.json({ place });
      })
      .catch(next);
  });

  return router;
}
