import { prisma } from '@machiya/db';
import type { AmenityGroup } from '@machiya/shared';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Every read of the `Amenity` table, in one place.
 *
 * The catalogue had no reader before the wizard needed one — `resolveAmenityIds`
 * validated slugs a client had already sent, and a listing's own amenities came
 * off the join. Those are different questions, but they are the same table, so
 * they live together rather than putting amenity queries in two services.
 */

/**
 * Every amenity, grouped by category.
 *
 * Grouped on the server rather than in the wizard because the grouping IS the
 * checklist's information architecture, and two clients grouping the same rows
 * differently would be two different forms.
 */
export async function listAmenities(): Promise<AmenityGroup[]> {
  const amenities = await prisma.amenity.findMany({
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    select: { id: true, slug: true, name: true, icon: true, category: true },
  });

  const groups = new Map<string, AmenityGroup>();

  for (const amenity of amenities) {
    const group = groups.get(amenity.category) ?? { category: amenity.category, amenities: [] };
    group.amenities.push(amenity);
    groups.set(amenity.category, group);
  }

  return [...groups.values()];
}

/**
 * Slugs to ids, refusing any the table does not have.
 *
 * A slug the client invented is a client bug, and silently dropping it would
 * publish a listing missing an amenity its owner ticked.
 */
export async function resolveAmenityIds(slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return [];

  const amenities = await prisma.amenity.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });

  const found = new Set(amenities.map((amenity) => amenity.slug));
  const missing = slugs.filter((slug) => !found.has(slug));

  if (missing.length > 0) {
    throw new HttpError(400, 'unknown_amenity', `Unknown amenities: ${missing.join(', ')}`);
  }

  return amenities.map((amenity) => amenity.id);
}
