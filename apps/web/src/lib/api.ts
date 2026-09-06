import { apiErrorSchema, type ApiError, type OutOfCoverage } from '@machiya/shared';
import type { z } from 'zod';
import { env } from '../env';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * Field-level detail and the served-city list, when the API sent them.
     *
     * Carried rather than flattened into the message because the wizard renders
     * the covered cities as one-tap buttons and highlights the field that
     * failed — see the note on `coverage` in `apiErrorSchema`.
     */
    readonly detail: Omit<ApiError['error'], 'code' | 'message'> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  get coverage(): OutOfCoverage | undefined {
    return this.detail.coverage;
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

    if (!parsedError.success) {
      throw new ApiRequestError(
        response.status,
        'unknown_error',
        // Not `statusText`: "Bad Gateway" ends up in a toast otherwise.
        'That did not go through. Nothing was lost — try again.',
      );
    }

    const { code, message, ...detail } = parsedError.data.error;
    throw new ApiRequestError(response.status, code, message, detail);
  }

  return schema.parse(payload);
}
