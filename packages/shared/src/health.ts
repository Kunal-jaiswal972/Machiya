import { z } from 'zod';

export const dependencyStatusSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  /** Round-trip latency of the probe, in milliseconds. */
  latencyMs: z.number().nonnegative(),
  /** Present only when the probe failed. Never carries connection strings. */
  error: z.string().optional(),
  /** Free-form probe detail, e.g. the reported PostGIS version. */
  detail: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string(),
  dependencies: z.array(dependencyStatusSchema),
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
