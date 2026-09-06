import type { MapStyleChoice } from '@machiya/shared';
import { env } from '../env';
import { useUiStore } from '../stores/ui';
import { useUiPreferences } from './use-ui-preferences';

/**
 * Which tile style the map is drawn with.
 *
 * `auto` follows the app theme, which is what almost everyone wants; the
 * override exists because a dark interface around a light map is a deliberate
 * look and not everyone reads it the same way. See DECISIONS.md D83.
 */
export interface MapStyleApi {
  url: string;
  /** What the person chose: `auto`, or a style pinned regardless of the app. */
  choice: MapStyleChoice;
  isDark: boolean;
  /** Pins the opposite style. Leaves `auto` behind, which is the intent. */
  toggle: () => void;
  set: (choice: MapStyleChoice) => void;
}

export function useMapStyle(): MapStyleApi {
  const theme = useUiStore((state) => state.theme);
  const { preferences, update } = useUiPreferences();

  const choice = preferences.mapStyle;
  const isDark = choice === 'auto' ? theme === 'dark' : choice === 'dark';

  return {
    url: isDark ? env.VITE_MAP_STYLE_URL_DARK : env.VITE_MAP_STYLE_URL,
    choice,
    isDark,
    toggle: () => update({ mapStyle: isDark ? 'light' : 'dark' }),
    set: (next) => update({ mapStyle: next }),
  };
}
