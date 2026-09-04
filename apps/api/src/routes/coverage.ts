import { recordCoverageRequest } from '@machiya/db';
import { coverageRequestInputSchema, roundCoverageRequestCoordinate } from '@machiya/shared';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { checkCoverage, coverageSet } from '../services/coverage.js';

/**
 * What the product covers, and a way to ask for more.
 *
 * `GET /api/coverage` is public and cached hard: it changes only when the OSM
 * artifacts are rebuilt, and the epoch in the payload is what tells a client
 * that happened. The client reads its city list from here rather than
 * hardcoding three slugs, which is what makes correction 8's "adding a city is
 * one record" claim true of the frontend as well.
 */
export function coverageRouter(): Router {
  const router = Router();

  router.get('/coverage', (_req, res) => {
    const set = coverageSet();

    // A day in a shared cache, and `must-revalidate` so a rebuild is picked up
    // on the next load rather than whenever a browser feels like it. The epoch
    // is in the body for the same reason: a client can compare it and refetch.
    res.set('cache-control', 'public, max-age=3600, s-maxage=86400, must-revalidate');
    res.set('etag', `W/"coverage-${set.epoch}-${String(set.cities.length)}"`);
    res.json(set);
  });

  /**
   * "Tell me when you cover Mumbai."
   *
   * Rate limited an order of magnitude harder than the rest of the API,
   * per-IP: this is an unauthenticated write with an email address in it, which
   * is exactly the shape of endpoint that gets used as a mail-bomb relay. It
   * sends no mail at all today — the row is the point — but the limit belongs
   * here before it ever does.
   */
  const captureLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
  });

  router.post('/coverage/requests', captureLimit, (req, res, next) => {
    const input = coverageRequestInputSchema.parse(req.body);

    const lat = roundCoverageRequestCoordinate(input.lat);
    const lng = roundCoverageRequestCoordinate(input.lng);

    // Refuse a request for a point we already cover. Not pedantry: a row here
    // is a vote for a new city, and votes for cities that already exist would
    // quietly poison the one number this table is for.
    checkCoverage({ lat, lng })
      .then(async (resolution) => {
        if (resolution.covered) {
          res.status(409).json({
            error: {
              code: 'already_covered',
              message: `Machiya already covers ${resolution.city.name} — search there instead.`,
            },
          });
          return;
        }

        const { asks, peopleNearby } = await recordCoverageRequest({
          email: input.email,
          lat,
          lng,
          ...(input.placeLabel ? { placeLabel: input.placeLabel } : {}),
        });

        logger.info(
          { lat, lng, placeLabel: input.placeLabel ?? null, asks, peopleNearby },
          'coverage requested',
        );

        res.status(201).json({ requests: peopleNearby });
      })
      .catch(next);
  });

  return router;
}
