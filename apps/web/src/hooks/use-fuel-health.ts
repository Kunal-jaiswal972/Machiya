import { fuelHealthReportSchema, type FuelHealthReport } from '@machiya/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

/**
 * Per-adapter fuel scrape health, for the admin page.
 *
 * `retry: false` because the two ways this fails are both terminal for a
 * retry: a 403 for a non-admin, and a 503 meaning the job has never run. Both
 * are states the page renders rather than errors worth attempting again, and
 * retrying a 403 three times just delays telling the user.
 */
export interface FuelHealthState {
  report: FuelHealthReport | null;
  isLoading: boolean;
  /** True when there is no report at all — which is NOT the same as healthy. */
  isMissing: boolean;
}

export function useFuelHealth(): FuelHealthState {
  const query = useQuery({
    queryKey: ['admin', 'fuel-health'],
    queryFn: () => apiFetch('/api/admin/fuel/health', fuelHealthReportSchema),
    // The job runs hourly; a minute of staleness on an ops page is fine, and
    // polling harder would just be noise on somebody's dashboard.
    refetchInterval: 60_000,
    retry: false,
  });

  return {
    report: query.data ?? null,
    isLoading: query.isPending,
    isMissing: query.isError || (!query.isPending && !query.data),
  };
}
