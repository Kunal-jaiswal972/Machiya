import { apiErrorSchema } from '@machiya/shared';
import type { z } from 'zod';
import { env } from '../env';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * Single fetch wrapper for the whole app.
 *
 * `credentials: 'include'` is required for the session cookie; every response is
 * validated against the shared schema so a drifting API surfaces as one clear
 * error instead of undefined fields deep in a component.
 */
export async function apiFetch<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  init: RequestInit = {},
): Promise<z.infer<TSchema>> {
  const response = await fetch(`${env.VITE_API_BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    ...init,
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    throw new ApiRequestError(
      response.status,
      parsedError.success ? parsedError.data.error.code : 'unknown_error',
      parsedError.success ? parsedError.data.error.message : response.statusText,
    );
  }

  return schema.parse(payload);
}
