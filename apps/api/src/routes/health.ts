import { Router } from 'express';
import type { DependencyStatus, HealthResponse } from '@machiya/shared';
import { geoArtifactStatus, type GeoArtifactStatus } from '../geo/manifest.js';

export interface HealthProbes {
  database(): Promise<{ ok: boolean; postgisVersion?: string }>;
  redis(): Promise<{ ok: boolean; detail?: string }>;
  /** Injected so the test can drive every state without a manifest on disk. */
  geoArtifacts?(): GeoArtifactStatus;
}

const VERSION = process.env.APP_VERSION ?? '0.1.0';

async function timed(
  name: string,
  probe: () => Promise<{ ok: boolean; detail?: string }>,
): Promise<DependencyStatus> {
  const startedAt = performance.now();
  try {
    const result = await probe();
    return {
      name,
      ok: result.ok,
      latencyMs: Math.round(performance.now() - startedAt),
      ...(result.detail ? { detail: result.detail } : {}),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

/**
 * Reports the API plus every dependency it cannot serve without, and answers 503
 * when any of them is down so Docker and any load balancer see the same truth
 * the JSON body states.
 */
export function healthRouter(probes: HealthProbes): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const dependencies = await Promise.all([
      timed('postgis', async () => {
        const result = await probes.database();
        return {
          ok: result.ok,
          ...(result.postgisVersion ? { detail: result.postgisVersion } : {}),
        };
      }),
      timed('redis', () => probes.redis()),
    ]);

    const body: HealthResponse = {
      status: dependencies.every((dependency) => dependency.ok) ? 'ok' : 'degraded',
      service: 'api',
      version: VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dependencies,
    };

    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  /**
   * Whether the OSM artifacts on this machine describe the city config this
   * process is running.
   *
   * A **separate** endpoint, deliberately. Rolling this into `/health` would
   * make a fresh clone unhealthy until someone ran `pnpm bootstrap`, and `web`
   * depends on `api: service_healthy` — so the core stack would refuse to come
   * up on a checkout with no artifacts, which D6 exists to prevent. What must
   * not happen is a newly added city serving empty results while everything
   * reports healthy, and that is exactly what a 503 here says.
   */
  router.get('/health/geo', (_req, res) => {
    const status = (probes.geoArtifacts ?? geoArtifactStatus)();

    res.status(status.ok ? 200 : 503).json({
      status: status.ok ? 'ok' : 'degraded',
      service: 'api',
      artifacts: status.state,
      reason: status.reason,
      epoch: status.epoch,
      configHash: status.configHash,
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', service: 'api', uptimeSeconds: Math.round(process.uptime()) });
  });

  return router;
}
