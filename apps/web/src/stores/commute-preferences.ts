import {
  DEFAULT_COMMUTE_PREFERENCES,
  commutePreferencesSchema,
  reconcileCommutePreferences,
  type CommutePreferences,
  type CommutePreferencesPatch,
} from '@machiya/shared';
import { create } from 'zustand';

const STORAGE_KEY = 'machiya:commute-preferences';

/**
 * The commute settings the panel is actually showing.
 *
 * Client-side, and that is the fix rather than a convenience. Before this the
 * only source was a server query gated on `isSignedIn`, so signed out there was
 * no cache entry, the optimistic update was a no-op against `undefined`, and
 * the PATCH 401'd — the controls moved nothing at all while the panel promised
 * they merely would not persist (docs/ux-audit.md 1.2).
 *
 * So the store is the source of truth for what is on screen, and the server is
 * where it is kept for next time. Signed in, the two are reconciled by
 * `useCommutePreferences`; signed out, the choices are still real and still
 * survive a reload.
 *
 * Parsed on the way out of storage, not cast: a blob written by an older shape
 * is a real possibility, and a missing mileage would reach the engine as
 * `undefined` and produce NaN rupees — a number that renders (D63).
 */
function fromStorage(): CommutePreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COMMUTE_PREFERENCES;
    const parsed = commutePreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_COMMUTE_PREFERENCES;
  } catch {
    return DEFAULT_COMMUTE_PREFERENCES;
  }
}

function toStorage(preferences: CommutePreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A private window with storage blocked still gets working controls for
    // this session; only the memory of them is lost.
  }
}

interface CommutePreferencesState {
  preferences: CommutePreferences;
  /**
   * True once the server's stored settings have been folded in, so a signed-in
   * user's own numbers are not briefly overwritten by this device's.
   */
  hydratedFromServer: boolean;
  /** Applies a change locally and returns the result, for the caller to persist. */
  apply: (patch: CommutePreferencesPatch) => CommutePreferences;
  /** Replaces the whole set from the server, without a write back. */
  adopt: (preferences: CommutePreferences) => void;
}

export const useCommutePreferencesStore = create<CommutePreferencesState>((set, get) => ({
  preferences: fromStorage(),
  hydratedFromServer: false,

  apply: (patch) => {
    // Re-parsed as a whole rather than merged field by field, then reconciled:
    // changing vehicle class clears a pinned mileage (D63), and switching mode
    // moves the vehicle to one that belongs to it. The reconcile rule lives in
    // `@machiya/shared` because the server applies the same one — two copies
    // would let the client show what the server would not charge.
    const current = get().preferences;
    const merged = reconcileCommutePreferences(
      commutePreferencesSchema.parse({
        ...current,
        ...patch,
        ...(patch.vehicleClass !== undefined && patch.mileageKmPerLitre === undefined
          ? { mileageKmPerLitre: null }
          : {}),
      }),
    );

    toStorage(merged);
    set({ preferences: merged });
    return merged;
  },

  adopt: (preferences) => {
    toStorage(preferences);
    set({ preferences, hydratedFromServer: true });
  },
}));
