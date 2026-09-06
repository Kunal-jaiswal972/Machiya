import { POI_CATEGORIES, type Poi, type PoiCategory, type RouteResult } from '@machiya/shared';
import { create } from 'zustand';

/**
 * What the detail panel wants drawn on the map behind it.
 *
 * A store rather than props, for one specific reason: the detail view is a
 * CHILD ROUTE of the search page, so it renders through an `<Outlet />`. Passing
 * the route geometry and the POIs up to the map would mean either lifting all
 * of it into the search page (which then re-renders on every POI arrival) or
 * threading it through context on the outlet. This is the same information
 * flowing one way, and the map subscribes to exactly the slices it draws.
 *
 * It holds no server data of its own — the panel's queries own that. This is
 * only the projection of it onto the map.
 */
interface DetailOverlayState {
  /** The listing the panel is showing, so the map can emphasise its marker. */
  listingId: string | null;
  routeGeometry: RouteResult['geometry'];
  pois: Poi[];
  /** Which POI categories are switched on. Empty means none. */
  visibleCategories: Set<PoiCategory>;

  setListing: (listingId: string | null) => void;
  setRouteGeometry: (geometry: RouteResult['geometry']) => void;
  setPois: (pois: Poi[]) => void;
  toggleCategory: (category: PoiCategory) => void;
  setCategories: (categories: PoiCategory[]) => void;
  /** Called when the panel closes; the map must not keep drawing its overlay. */
  clear: () => void;
}

const CATEGORY_KEY = 'machiya:poi-categories';

/**
 * Chosen categories outlive the listing they were chosen on.
 *
 * Someone who wants hospitals wants hospitals on the next flat too, so this is
 * per person rather than per panel — kept on the device because it is a view
 * setting, not something worth a round trip.
 */
function storedCategories(): Set<PoiCategory> {
  try {
    const raw = localStorage.getItem(CATEGORY_KEY);
    if (!raw) return new Set<PoiCategory>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<PoiCategory>();
    return new Set(parsed.filter((value): value is PoiCategory => POI_CATEGORIES.includes(value)));
  } catch {
    return new Set<PoiCategory>();
  }
}

function rememberCategories(categories: Set<PoiCategory>): void {
  try {
    localStorage.setItem(CATEGORY_KEY, JSON.stringify([...categories]));
  } catch {
    // The choice still holds for this session.
  }
}

export const useDetailOverlay = create<DetailOverlayState>((set) => ({
  listingId: null,
  routeGeometry: null,
  pois: [],
  // Nothing on for a first visit: seven categories at once over a dense city is
  // a mess, and the legend is the invitation to turn one on. After that it is
  // whatever was last chosen.
  visibleCategories: storedCategories(),

  setListing: (listingId) => set({ listingId }),
  setRouteGeometry: (routeGeometry) => set({ routeGeometry }),
  setPois: (pois) => set({ pois }),
  toggleCategory: (category) =>
    set((state) => {
      const next = new Set(state.visibleCategories);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      rememberCategories(next);
      return { visibleCategories: next };
    }),
  setCategories: (categories) => {
    const next = new Set(categories);
    rememberCategories(next);
    set({ visibleCategories: next });
  },
  // The categories deliberately survive: closing a listing clears what was
  // drawn for it, not what the person asked to see.
  clear: () => set({ listingId: null, routeGeometry: null, pois: [] }),
}));
