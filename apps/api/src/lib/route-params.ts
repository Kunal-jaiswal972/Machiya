import type { Request } from 'express';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Reads a required path parameter as a single string.
 *
 * Express 5 types params as `string | string[] | undefined`, because a route
 * pattern can repeat a name. Rather than assert the type away at a dozen call
 * sites, this narrows once and fails loudly if a route is ever wired with a
 * pattern that does not match its handler.
 */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];

  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'invalid_path', `Missing "${name}" in the path`);
  }

  return value;
}
