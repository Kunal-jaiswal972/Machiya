import { coordinateSchema, routeProfileSchema } from '@machiya/shared';
import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../lib/route-params.js';
import { optionalAuth, type SessionResolver } from '../middleware/require-auth.js';
import {
  getListingPois,
  getListingRoute,
  getSimilarListings,
  recordListingView,
} from '../services/listing-detail.js';

const routeQuerySchema = z.object({
  fromLat: z.coerce.number(),
  fromLng: z.coerce.number(),
  profile: routeProfileSchema.default('car'),
});

/**
 * The detail view's satellite reads: route, nearby places, similar listings, and
 * the view ping.
 *
 * Each is its own request rather than fields on the listing response, because
 * each has a different failure mode and a different TTL — and none of them may
 * hold up the page. A detail view that waits for Overpass before showing a rent
 * is a detail view that is occasionally 25 seconds slow.
 */
export function listingDetailRouter(resolve: SessionResolver): Router {
  const router = Router();

  router.get('/listings/:slug/route', (req, res, next) => {
    const { fromLat, fromLng, profile } = routeQuerySchema.parse(req.query);
    const from = coordinateSchema.parse({ lat: fromLat, lng: fromLng });

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    getListingRoute({
      slug: pathParam(req, 'slug'),
      from,
      profile,
      signal: controller.signal,
    })
      .then((route) => {
        // Cached server-side for 24h; a shorter browser cache keeps a profile
        // switch instant without pinning a stale geometry for the session.
        res.set('cache-control', 'private, max-age=600');
        res.json({ route });
      })
      .catch(next);
  });

  router.get('/listings/:slug/pois', (req, res, next) => {
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    getListingPois({ slug: pathParam(req, 'slug'), signal: controller.signal })
      .then((result) => {
        res.set('cache-control', 'private, max-age=600');
        res.json(result);
      })
      .catch(next);
  });

  router.get('/listings/:slug/similar', (req, res, next) => {
    getSimilarListings(pathParam(req, 'slug'))
      .then((listings) => {
        res.set('cache-control', 'private, max-age=300');
        res.json({ listings });
      })
      .catch(next);
  });

  /**
   * The view ping. `optionalAuth` because an anonymous view still counts — it
   * is deduplicated by a hashed IP and user-agent instead of a user id.
   *
   * Always 202, even when the view was not counted: whether a particular view
   * was deduplicated is not the client's business, and telling it would just
   * invite retries.
   */
  router.post('/listings/:slug/view', optionalAuth(resolve), (req, res, next) => {
    recordListingView({
      slug: pathParam(req, 'slug'),
      userId: req.auth?.userId,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    })
      .then(() => res.status(202).json({ ok: true }))
      .catch(next);
  });

  return router;
}
