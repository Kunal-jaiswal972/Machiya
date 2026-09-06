import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'machiya:theme';

/**
 * Dark unless this browser has been told otherwise.
 *
 * A stored choice wins; there is no read of `prefers-color-scheme`, because the
 * product is designed dark (docs/design.md) and the system setting is a fact
 * about someone's operating system rather than about this map. The toggle is
 * one press away and is remembered.
 */
function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

/** Persisted only when the person chose it — see `setTheme`. */
function applyTheme(theme: Theme, persist: boolean): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  if (!persist) return;

  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private window: the theme holds for this session and is not remembered.
  }
}

interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

/**
 * Zustand holds UI and map state only. Anything that comes from the server
 * belongs to TanStack Query.
 */
export const useUiStore = create<UiState>((set, get) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    applyTheme(theme, true);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));

// The DOM starts in step with the store, and the default is NOT written back:
// storing it on boot would turn "we picked dark for you" into "you chose dark".
applyTheme(useUiStore.getState().theme, false);
