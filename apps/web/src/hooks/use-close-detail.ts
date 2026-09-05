import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

/**
 * Closing the listing panel, from the panel or from the map behind it.
 *
 * The router's key rather than `window.history.length`, which counts the whole
 * tab: a listing opened from a link on another site would otherwise send the
 * user back to that site instead of to the search (docs/ux-audit.md 1.7).
 * `default` is the entry the tab loaded on, and only then is there no search of
 * ours to go back to.
 */
export function useCloseDetail(): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  return useCallback(() => {
    if (location.key !== 'default') {
      void navigate(-1);
      return;
    }
    void navigate({ pathname: '/', search: searchParams.toString() });
  }, [location.key, navigate, searchParams]);
}
