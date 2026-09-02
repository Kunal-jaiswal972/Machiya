import { z } from 'zod';

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
