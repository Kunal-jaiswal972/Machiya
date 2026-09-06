import {
  DEFAULT_UI_PREFERENCES,
  uiPreferencesSchema,
  type UiPreferences,
  type UiPreferencesPatch,
} from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth-context';

const responseSchema = z.object({ preferences: uiPreferencesSchema });
const KEY = ['ui-preferences'] as const;
const STORAGE_KEY = 'machiya:ui-preferences';

/**
 * Map style and tour state, from the account when there is one.
 *
 * The browser copy is not a cache of the server's — it is what a signed-out
 * visitor has, and it is written first so a control moves the moment it is
 * pressed. Signing in adopts the account's copy, because that is the one that
 * followed the person here.
 */
function fromStorage(): UiPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_UI_PREFERENCES;
    const parsed = uiPreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_UI_PREFERENCES;
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

function toStorage(preferences: UiPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A private window keeps working; only the memory of it is lost.
  }
}

export function useUiPreferences() {
  const { isSignedIn } = useAuth();
  const client = useQueryClient();

  const query = useQuery({
    queryKey: KEY,
    enabled: isSignedIn,
    queryFn: () => apiFetch('/api/me/preferences', responseSchema),
    staleTime: 5 * 60_000,
  });

  const preferences = isSignedIn ? (query.data?.preferences ?? fromStorage()) : fromStorage();

  const mutation = useMutation({
    mutationFn: (next: UiPreferences) =>
      apiFetch('/api/me/preferences', responseSchema, {
        method: 'PATCH',
        body: JSON.stringify(next),
      }),
    onSuccess: (result) => {
      client.setQueryData(KEY, result);
    },
  });

  const update = (patch: UiPreferencesPatch): UiPreferences => {
    const next = uiPreferencesSchema.parse({ ...preferences, ...patch });
    toStorage(next);
    // Optimistic on the client's own copy, so a control never lags its press.
    client.setQueryData(KEY, { preferences: next });
    if (isSignedIn) mutation.mutate(next);
    return next;
  };

  return {
    preferences,
    update,
    /** True while nothing is known yet, so the tour does not fire on a guess. */
    isLoading: isSignedIn && query.isPending,
    isPersisted: isSignedIn,
  };
}
