import { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Client errors will not fix themselves on a retry.
        if (error instanceof ApiRequestError && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});
