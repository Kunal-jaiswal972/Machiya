import { useEffect, useState } from 'react';

/**
 * Trailing-edge debounce for a value.
 *
 * Used to keep the autocomplete's remote tier off the critical path of typing:
 * the input stays fully responsive because it renders the raw value, while the
 * query key only moves once the user pauses.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
