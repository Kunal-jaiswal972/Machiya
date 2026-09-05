import { listingStatusActionSchema, listingStatusSchema } from '@machiya/shared';
import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../lib/route-params.js';
import {
  optionalAuth,
  requireAuth,
  sessionOf,
  type SessionResolver,
} from '../middleware/require-auth.js';
import {
  deleteImage,
  markImageUploaded,
  reorderImages,
  requestImageUpload,
} from '../services/listing-images.js';
import { getListerAnalytics } from '../services/lister-analytics.js';
import {
  changeStatus,
  createDraft,
  deleteListing,
  duplicateListing,
  getDraft,
  getListingBySlug,
  listOwned,
  patchListing,
} from '../services/listings.js';

const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).optional(),
  /** Honoured for admins only; see getListerAnalytics. */
  ownerId: z.string().min(1).optional(),
});

const ownedQuerySchema = z.object({
  status: listingStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
  /** Honoured for admins only; see listOwned. */
  ownerId: z.string().min(1).optional(),
});

/**
 * Listing CRUD.
 *
 * Every mutation is `requireAuth` plus an ownership re-check inside the service
 * against the stored row — the route never trusts an owner id from the client,
 * and there is no role gate on create: a seeker may draft a listing and is
 * upgraded to lister when they publish it.
 */
export function listingsRouter(resolve: SessionResolver): Router {
  const router = Router();
  const authed = requireAuth(resolve);

  router.post('/listings', authed, (req, res, next) => {
    createDraft(sessionOf(req), req.body)
      .then((listing) => res.status(201).json({ listing }))
      .catch(next);
  });

  // Ahead of /listings/:slug so "mine" is never read as a slug.
  router.get('/listings/mine', authed, (req, res, next) => {
    const query = ownedQuerySchema.parse(req.query);
    listOwned(sessionOf(req), query)
      .then((result) => res.json(result))
      .catch(next);
  });

  // Ahead of /listings/:slug for the same reason as "mine": the wizard reads by
  // id, and an id would otherwise be looked up as a slug and 404.
  router.get('/listings/:id/draft', authed, (req, res, next) => {
    getDraft(sessionOf(req), pathParam(req, 'id'))
      .then((draft) => res.json({ draft }))
      .catch(next);
  });

  router.get('/listings/mine/analytics', authed, (req, res, next) => {
    const query = analyticsQuerySchema.parse(req.query);
    getListerAnalytics(sessionOf(req), query)
      .then((analytics) => res.json(analytics))
      .catch(next);
  });

  router.post('/listings/:id/duplicate', authed, (req, res, next) => {
    duplicateListing(sessionOf(req), pathParam(req, 'id'))
      .then((listing) => res.status(201).json({ listing }))
      .catch(next);
  });

  router.get('/listings/:slug', optionalAuth(resolve), (req, res, next) => {
    getListingBySlug(pathParam(req, 'slug'), req.auth)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.patch('/listings/:id', authed, (req, res, next) => {
    patchListing(sessionOf(req), pathParam(req, 'id'), req.body)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.post('/listings/:id/status', authed, (req, res, next) => {
    const parsed = z.object({ action: listingStatusActionSchema }).safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'validation_failed',
          message: 'action must be one of: publish, pause, unpause, mark-rented',
        },
      });
      return;
    }

    changeStatus(sessionOf(req), pathParam(req, 'id'), parsed.data.action)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.delete('/listings/:id', authed, (req, res, next) => {
    deleteListing(sessionOf(req), pathParam(req, 'id'))
      .then((result) => res.json(result))
      .catch(next);
  });

  // --- images --------------------------------------------------------------

  router.post('/listings/:id/images', authed, (req, res, next) => {
    requestImageUpload(sessionOf(req), pathParam(req, 'id'), req.body)
      .then((ticket) => res.status(201).json({ ticket }))
      .catch(next);
  });

  // The client calls this once its direct upload finishes. The API confirms the
  // object exists and queues derivation; it never reads the bytes.
  router.post('/listings/:id/images/:imageId/uploaded', authed, (req, res, next) => {
    markImageUploaded(sessionOf(req), pathParam(req, 'id'), pathParam(req, 'imageId'))
      .then((image) => res.status(202).json({ image }))
      .catch(next);
  });

  router.patch('/listings/:id/images/order', authed, (req, res, next) => {
    reorderImages(sessionOf(req), pathParam(req, 'id'), req.body)
      .then((images) => res.json({ images }))
      .catch(next);
  });

  router.delete('/listings/:id/images/:imageId', authed, (req, res, next) => {
    deleteImage(sessionOf(req), pathParam(req, 'id'), pathParam(req, 'imageId'))
      .then((result) => res.json(result))
      .catch(next);
  });

  return router;
}
