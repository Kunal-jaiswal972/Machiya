import { z } from 'zod';

/**
 * Preferences about the product itself, as opposed to the commute maths.
 *
 * Stored on the user rather than in the browser: "I have seen the tour" and
 * "I read maps better in the dark" are facts about a person, and putting them
 * in `localStorage` runs the tour again on their phone and lights the map up
 * on their laptop. Signed out, the browser copy is all there is — which is the
 * right answer for a visitor with no account rather than a compromise.
 *
 * `auto` is not a third map style: it means "whatever the app theme is", which
 * is the default and what most people want. The override exists because a dark
 * interface with a light map is a deliberate look (see docs/design.md) and some
 * people prefer it in reverse.
 */
export const mapStyleChoiceSchema = z.enum(['auto', 'light', 'dark']);
export type MapStyleChoice = z.infer<typeof mapStyleChoiceSchema>;

export const uiPreferencesSchema = z.object({
  mapStyle: mapStyleChoiceSchema.default('auto'),
  /** ISO timestamp, or null for someone who has never finished or dismissed it. */
  tourCompletedAt: z.string().nullable().default(null),
});

export type UiPreferences = z.infer<typeof uiPreferencesSchema>;

export const uiPreferencesPatchSchema = uiPreferencesSchema.partial();
export type UiPreferencesPatch = z.infer<typeof uiPreferencesPatchSchema>;

export const DEFAULT_UI_PREFERENCES: UiPreferences = uiPreferencesSchema.parse({});
