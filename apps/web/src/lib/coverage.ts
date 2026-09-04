import {
  coverageRequestResponseSchema,
  type CoverageRequestInput,
  type CoverageRequestResponse,
} from '@machiya/shared';
import { apiFetch } from './api';

/**
 * "Tell me when you cover Mumbai."
 *
 * Writes a `CoverageRequest` row and returns how many distinct people have now
 * asked about somewhere within 50 km of that point — which is the number worth
 * showing back, because it tells the person their request joined a pile rather
 * than vanished.
 */
export async function requestCoverage(
  input: CoverageRequestInput,
): Promise<CoverageRequestResponse> {
  return apiFetch('/api/coverage/requests', coverageRequestResponseSchema, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
