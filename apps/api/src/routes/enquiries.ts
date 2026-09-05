import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../lib/route-params.js';
import { requireAuth, sessionOf, type SessionResolver } from '../middleware/require-auth.js';
import {
  createEnquiry,
  getEnquiry,
  listEnquiries,
  markEnquiryRead,
  replyToEnquiry,
  setEnquiryStatus,
} from '../services/enquiries.js';

const listQuerySchema = z.object({
  /** Which side of the conversation to show. Both when absent. */
  role: z.enum(['seeker', 'lister']).optional(),
});

/**
 * Enquiry threads. Every route is authenticated and scoped to a party of the
 * thread — an enquiry is a private conversation about somebody's home, so there
 * is no public read and no owner override beyond admin.
 */
export function enquiriesRouter(resolve: SessionResolver): Router {
  const router = Router();
  const authed = requireAuth(resolve);

  router.get('/enquiries', authed, (req, res, next) => {
    const query = listQuerySchema.parse(req.query);
    listEnquiries(sessionOf(req), query)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.get('/enquiries/:id', authed, (req, res, next) => {
    getEnquiry(sessionOf(req), pathParam(req, 'id'))
      .then((result) => res.json(result))
      .catch(next);
  });

  router.post('/enquiries/:id/messages', authed, (req, res, next) => {
    replyToEnquiry(sessionOf(req), pathParam(req, 'id'), req.body)
      .then((message) => res.status(201).json({ message }))
      .catch(next);
  });

  router.post('/enquiries/:id/read', authed, (req, res, next) => {
    markEnquiryRead(sessionOf(req), pathParam(req, 'id'))
      .then((result) => res.json(result))
      .catch(next);
  });

  router.patch('/enquiries/:id', authed, (req, res, next) => {
    setEnquiryStatus(sessionOf(req), pathParam(req, 'id'), req.body)
      .then((result) => res.json(result))
      .catch(next);
  });

  // Keyed by SLUG, because this is reached from the public listing page where
  // the slug is what the reader has.
  router.post('/listings/:slug/enquiries', authed, (req, res, next) => {
    createEnquiry(sessionOf(req), pathParam(req, 'slug'), req.body)
      .then((result) => res.status(201).json(result))
      .catch(next);
  });

  return router;
}
