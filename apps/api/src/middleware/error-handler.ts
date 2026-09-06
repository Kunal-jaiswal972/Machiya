import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@machiya/shared';
import { logger } from '../logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Field-level detail, when the caller can act on it per field. */
    private readonly extra: Partial<ApiError['error']> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /**
   * Extra fields this error contributes to the `error` object in the response.
   *
   * Whatever the thrower passed, which is nothing for most errors.
   * `OutOfCoverageError` overrides it to carry the served-city list, so the
   * handler below stays the single place a client-facing body is assembled
   * rather than growing a special case per error type.
   */
  body(): Partial<ApiError['error']> {
    return this.extra;
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  const body: ApiError = {
    // The method and path go to the log, not to whoever reads the message.
    error: { code: 'not_found', message: 'That is not here any more.' },
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
        message: 'Some of that did not look right.',
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
    const body: ApiError = {
      error: { code: err.code, message: err.message, ...err.body() },
    };
    res.status(err.status).json(body);
    return;
  }

  logger.error({ err }, 'unhandled request error');
  const body: ApiError = {
    error: {
      code: 'internal_error',
      message: 'That did not go through. Nothing was lost — try again.',
    },
  };
  res.status(500).json(body);
};
