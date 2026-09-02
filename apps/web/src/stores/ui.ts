import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'machiya:theme';

function initialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem(STORAGE_KEY, theme);
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
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));

// Keep the DOM in step with the store's starting value.
applyTheme(useUiStore.getState().theme);
