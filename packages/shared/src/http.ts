import { z } from 'zod';
import { outOfCoverageSchema } from './geo/coverage.js';

/** Every non-2xx API response has this shape. Nothing else is thrown at clients. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field-level detail, present only for validation failures. */
    issues: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
    /**
     * Present only on an `out_of_coverage` refusal.
     *
     * Structured rather than folded into `message`, because the wizard renders
     * the supported cities as one-tap actions — and a UI that has to regex a
     * city list out of an English sentence is a UI that breaks when the
     * sentence changes. This is the only error in the API that carries a
     * payload; if a second one ever needs it, that is the moment to generalise,
     * not before.
     */
    coverage: outOfCoverageSchema.optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const helloResponseSchema = z.object({
  message: z.string(),
  service: z.string(),
  timestamp: z.string(),
});

export type HelloResponse = z.infer<typeof helloResponseSchema>;

/** Cursor pagination envelope used by every list endpoint. */
export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
