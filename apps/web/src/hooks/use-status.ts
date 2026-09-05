import { healthResponseSchema, helloResponseSchema } from '@machiya/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

/**
 * The scaffolding probe behind `StatusCard`: web to API to Postgres and Redis.
 *
 * Here rather than in the component for the same reason as every other fetch in
 * this app — components render, hooks fetch. It is the oldest code in the web
 * app and was the last place still mixing the two.
 */
export function useStatusProbe() {
  const hello = useQuery({
    queryKey: ['hello'],
    queryFn: () => apiFetch('/api/hello', helloResponseSchema),
  });

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch('/health', healthResponseSchema),
  });

  return { hello, health };
}
