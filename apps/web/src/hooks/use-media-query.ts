import { useEffect, useState } from 'react';

/**
 * A media query as state, so a component can render one thing OR the other
 * rather than rendering both and hiding one with CSS.
 *
 * That distinction matters more than it looks. The detail panel is a sidebar on
 * desktop and a bottom sheet on mobile; rendering both and toggling `hidden`
 * put the whole listing in the DOM twice — two `aria-label="Listing detail"`
 * landmarks, every control duplicated, and a screen reader reading the price
 * twice. `lg:hidden` is fine for a toggle button. It is not fine for a panel.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);

    // Set once on mount too: the query may have changed between the initial
    // state and the effect running.
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** The one breakpoint the layout actually changes at, matching Tailwind's `lg`. */
export const DESKTOP_QUERY = '(min-width: 1024px)';
