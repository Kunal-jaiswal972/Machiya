import { create } from 'zustand';

/**
 * Ephemeral map/list interaction state. Nothing here belongs in the URL (it is
 * not worth sharing) and nothing here comes from the server.
 *
 * `hoveredId` is the map-list hover sync — the interaction that sells the
 * product, per docs/design.md. It lives in a store rather than in the search
 * page's state for one specific reason: hovering a card must not re-render the
 * result list. The list subscribes per card, the map reads it in an effect, and
 * a hover therefore touches two DOM nodes instead of sixty.
 */
export type ResultsView = 'map' | 'list';

interface SearchUiState {
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;

  /**
   * `list` is the keyboard and screen-reader path, and a real view with its own
   * toggle rather than a hidden div — a map is not navigable by keyboard, and
   * the accessible representation should not be the degraded one.
   */
  view: ResultsView;
  setView: (view: ResultsView) => void;

  /** Mobile sheet position. Peek shows the count; half is the list. */
  sheet: 'peek' | 'half' | 'full';
  setSheet: (sheet: 'peek' | 'half' | 'full') => void;
}

export const useSearchUi = create<SearchUiState>((set) => ({
  hoveredId: null,
  setHoveredId: (hoveredId) => set({ hoveredId }),
  view: 'map',
  setView: (view) => set({ view }),
  sheet: 'half',
  setSheet: (sheet) => set({ sheet }),
}));
