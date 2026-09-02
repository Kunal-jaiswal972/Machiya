import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@machiya/shared';
import { logger } from '../logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiError = {
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  };
  res.status(404).json(body);
};

/**
 * Terminal error handler. Clients get a code and a safe message; the stack and
 * the original error stay in the logs.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    const body: ApiError = {
      error: {
        code: 'validation_failed',
        message: 'Request validation failed',
        issues: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof HttpError) {
    const body: ApiError = { error: { code: err.code, message: err.message } };
    res.status(err.status).json(body);
    return;
  }

  logger.error({ err }, 'unhandled request error');
  const body: ApiError = {
    error: { code: 'internal_error', message: 'Something went wrong on our side' },
  };
  res.status(500).json(body);
};
