import { Router } from 'express';
import type { HelloResponse } from '@machiya/shared';

export function helloRouter(): Router {
  const router = Router();

  router.get('/hello', (_req, res) => {
    const body: HelloResponse = {
      message: 'Machiya API is up. Set your office, find your rent.',
      service: 'api',
      timestamp: new Date().toISOString(),
    };
    res.json(body);
  });

  return router;
}
