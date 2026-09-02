import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { healthResponseSchema, helloResponseSchema, apiErrorSchema } from '@machiya/shared';
import { createApp } from '../src/app.js';
import type { HealthProbes } from '../src/routes/health.js';

const healthyProbes: HealthProbes = {
  database: async () => ({ ok: true, postgisVersion: '3.4.2' }),
  redis: async () => ({ ok: true, detail: 'PONG' }),
};

function app(probes: HealthProbes = healthyProbes) {
  return createApp({
    probes,
    requestLogging: false,
    corsOrigins: ['http://localhost:5173'],
    // Mounting Better Auth would construct a Prisma client and a Redis
    // connection; these tests are about the routes, not the provider.
    mountAuth: false,
  });
}

describe('GET /health', () => {
  it('reports ok with every dependency up', async () => {
    const response = await request(await app()).get('/health');

    expect(response.status).toBe(200);
    const body = healthResponseSchema.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.dependencies.map((dependency) => dependency.name)).toEqual(['postgis', 'redis']);
  });

  it('answers 503 and names the failing dependency when one is down', async () => {
    const response = await request(
      await app({
        database: async () => ({ ok: true, postgisVersion: '3.4.2' }),
        redis: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
    ).get('/health');

    expect(response.status).toBe(503);
    const body = healthResponseSchema.parse(response.body);
    expect(body.status).toBe('degraded');
    const redis = body.dependencies.find((dependency) => dependency.name === 'redis');
    expect(redis?.ok).toBe(false);
    expect(redis?.error).toContain('ECONNREFUSED');
  });

  it('reports degraded when PostGIS is missing from the server', async () => {
    const response = await request(
      await app({
        database: async () => ({ ok: false }),
        redis: async () => ({ ok: true, detail: 'PONG' }),
      }),
    ).get('/health');

    expect(response.status).toBe(503);
    expect(healthResponseSchema.parse(response.body).status).toBe('degraded');
  });
});

describe('GET /health/live', () => {
  it('answers without touching any dependency', async () => {
    const response = await request(
      await app({
        database: async () => {
          throw new Error('should not be called');
        },
        redis: async () => {
          throw new Error('should not be called');
        },
      }),
    ).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});

describe('GET /api/hello', () => {
  it('returns the hello payload', async () => {
    const response = await request(await app()).get('/api/hello');

    expect(response.status).toBe(200);
    expect(() => helloResponseSchema.parse(response.body)).not.toThrow();
  });
});

describe('unknown routes', () => {
  it('return the shared error envelope', async () => {
    const response = await request(await app()).get('/api/definitely-not-a-route');

    expect(response.status).toBe(404);
    const body = apiErrorSchema.parse(response.body);
    expect(body.error.code).toBe('not_found');
  });
});
