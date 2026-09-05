import {
  commuteParamsQuerySchema,
  commutePreferencesPatchSchema,
  coordinateSchema,
} from '@machiya/shared';
import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../lib/route-params.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  optionalAuth,
  requireAuth,
  requireRole,
  sessionOf,
  type SessionResolver,
} from '../middleware/require-auth.js';
import {
  getCommutePreferences,
  getListingCommute,
  updateCommutePreferences,
} from '../services/commute.js';
import { getFuelHealth, getFuelSnapshot } from '../services/fuel.js';

const commuteQuerySchema = z.object({
  fromLat: z.coerce.number(),
  fromLng: z.coerce.number(),
});

/**
 * Fuel prices, commute cost and the settings behind it.
 *
 * The fuel read is public — a commute cost is the product's argument and it has
 * to work before anyone signs in. Preferences are per-user and therefore
 * authenticated, and the scrape health page is admin-only.
 */
export function fuelRouter(resolve: SessionResolver): Router {
  const router = Router();

  /**
   * Live fuel prices for a city.
   *
   * Reads Redis and never blocks on a scrape: a miss serves the last stored
   * rows with `staleAt` set and enqueues a refresh in the background. See
   * `getFuelSnapshot`.
   */
  router.get('/fuel/:citySlug', (req, res, next) => {
    getFuelSnapshot(pathParam(req, 'citySlug'))
      .then((snapshot) => {
        if (!snapshot) {
          // 404 rather than an empty snapshot: "we have no price for this city"
          // is different from "fuel is free here", and a zero would flow into a
          // commute cost as an answer.
          next(
            new HttpError(
              404,
              'no_fuel_price',
              'No fuel price has been recorded for that city yet',
            ),
          );
          return;
        }

        // A short browser cache only. The server-side copy has the real 1-hour
        // TTL, and pinning a stale price in a browser for an hour would defeat
        // the refresh the miss just enqueued.
        res.set('cache-control', 'public, max-age=120');
        res.json(snapshot);
      })
      .catch(next);
  });

  /**
   * Commute cost for one listing from one office.
   *
   * `optionalAuth` because the numbers must render for an anonymous visitor —
   * they get the defaults — while a signed-in user gets their own settings.
   */
  router.get('/listings/:slug/commute', optionalAuth(resolve), (req, res, next) => {
    const { fromLat, fromLng } = commuteQuerySchema.parse(req.query);
    const from = coordinateSchema.parse({ lat: fromLat, lng: fromLng });

    // Parsed separately rather than merged into the schema above: the settings
    // the answer depends on travel in the URL so that the URL determines the
    // response and the cache below is honest (D76). Two parses beat composing
    // the schemas — zod 4's `extend` takes a plain shape, and handing it a
    // schema throws at request time rather than at build time.
    const overrides = commuteParamsQuerySchema.parse(req.query);
    const hasOverrides = Object.values(overrides).some((value) => value !== undefined);

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    getListingCommute({
      slug: pathParam(req, 'slug'),
      from,
      ...(req.auth ? { session: req.auth } : {}),
      ...(hasOverrides ? { overrides } : {}),
      signal: controller.signal,
    })
      .then((commute) => {
        // Cacheable only when the URL says what the answer depends on.
        //
        // This used to be `private, max-age=120` unconditionally, while the
        // answer varied by the caller's STORED settings — which appear in no
        // URL and no Vary header. The browser then served its own copy for two
        // minutes, so changing a setting left every figure on screen unmoved
        // until the cache expired. That was the whole of "the commute inputs do
        // nothing". See docs/ux-audit.md 1.1 and DECISIONS.md D76.
        res.set('cache-control', hasOverrides ? 'private, max-age=120' : 'private, no-store');
        res.json(commute);
      })
      .catch(next);
  });

  router.get('/me/commute', requireAuth(resolve), (req, res, next) => {
    getCommutePreferences(sessionOf(req).userId)
      .then((preferences) => res.json({ preferences }))
      .catch(next);
  });

  router.patch('/me/commute', requireAuth(resolve), (req, res, next) => {
    const patch = commutePreferencesPatchSchema.parse(req.body);

    updateCommutePreferences(sessionOf(req), patch)
      .then((preferences) => res.json({ preferences }))
      .catch(next);
  });

  /**
   * Per-adapter scrape health.
   *
   * Admin-only, and the reason it exists at all: with several sources per fuel
   * type the interesting failure is **one adapter silently dying while the
   * others cover for it**. Prices keep flowing, every page looks right, and the
   * redundancy that was the entire point is gone.
   */
  router.get(
    '/admin/fuel/health',
    // Both, in order: requireAuth resolves the session, requireRole gates it.
    // requireRole on its own 401s, so it is never mounted alone.
    requireAuth(resolve),
    requireRole('ADMIN'),
    (_req, res, next) => {
      getFuelHealth()
        .then((health) => {
          if (!health) {
            // Absent is not healthy. The job writes this without a TTL
            // precisely so that nothing here means the job has never run.
            res.status(503).json({
              error: {
                code: 'no_scrape_yet',
                message: 'The fuel scrape has not run since this Redis was last cleared',
              },
            });
            return;
          }

          res.set('cache-control', 'no-store');
          res.json(health);
        })
        .catch(next);
    },
  );

  return router;
}
