import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from './geo/index.js';

/**
 * A saved office. The only place a signed-in user's own coordinate is stored,
 * so it is deliberately small: a label they chose, the address the geocoder
 * gave, and the point.
 */
export const officeInputSchema = z.object({
  label: z.string().trim().min(1, 'Give this office a name').max(60),
  /**
   * What the geocoder returned, or the coordinates when it returned nothing —
   * a dropped pin over an unmapped field is a legitimate office, so this is
   * never allowed to block saving one.
   */
  address: z.string().trim().min(1).max(240),
  lat: latitudeSchema,
  lng: longitudeSchema,
  isDefault: z.boolean().default(false),
});

export type OfficeInput = z.infer<typeof officeInputSchema>;

export const officePatchSchema = officeInputSchema.partial();

export type OfficePatch = z.infer<typeof officePatchSchema>;

export const officeSchema = z.object({
  id: z.string(),
  label: z.string(),
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  isDefault: z.boolean(),
  createdAt: z.coerce.date(),
});

export type Office = z.infer<typeof officeSchema>;

export const officeListSchema = z.object({ offices: z.array(officeSchema) });

/** How many a single account may keep. Generous, but not unbounded. */
export const MAX_OFFICES_PER_USER = 12;
