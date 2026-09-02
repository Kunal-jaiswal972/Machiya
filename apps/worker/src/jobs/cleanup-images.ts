import { prisma } from '@machiya/db';
import { ORIGINALS_PREFIX } from '@machiya/shared/images';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { deleteObjects, listObjectKeys } from '../lib/storage.js';

export interface CleanupResult {
  stalePending: number;
  orphanedObjects: number;
}

/**
 * Sweeps the two ways an upload can leak.
 *
 * 1. A PENDING row whose client never called `uploaded` — the wizard was closed,
 *    the phone died. It would otherwise sit in the gallery as a spinner forever.
 * 2. An object under `originals/` with no row pointing at it — the presign
 *    succeeded, the upload landed, and then the row was deleted underneath it.
 *
 * Both are bounded by an age cutoff so an upload in flight is never swept.
 */
export async function cleanupImages(): Promise<CleanupResult> {
  const cutoff = new Date(Date.now() - env.IMAGE_CLEANUP_AFTER_HOURS * 60 * 60 * 1000);

  const stale = await prisma.listingImage.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    select: { id: true, objectKey: true },
  });

  if (stale.length > 0) {
    await prisma.listingImage.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    await deleteObjects(stale.flatMap((row) => (row.objectKey ? [row.objectKey] : [])));
    logger.info({ count: stale.length }, 'swept stale pending images');
  }

  const objects = await listObjectKeys(`${ORIGINALS_PREFIX}/`);
  const candidates = objects.filter(
    (object) => !object.lastModified || object.lastModified < cutoff,
  );

  // Key shape is originals/{listingId}/{imageId}.{ext}.
  const idsByKey = new Map<string, string>();
  for (const object of candidates) {
    const file = object.key.split('/').at(-1);
    const imageId = file?.replace(/\.[^.]+$/, '');
    if (imageId) idsByKey.set(object.key, imageId);
  }

  const known = new Set(
    (
      await prisma.listingImage.findMany({
        where: { id: { in: [...idsByKey.values()] } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  const orphaned = [...idsByKey.entries()]
    .filter(([, imageId]) => !known.has(imageId))
    .map(([key]) => key);

  if (orphaned.length > 0) {
    await deleteObjects(orphaned);
    logger.info({ count: orphaned.length }, 'deleted orphaned originals');
  }

  return { stalePending: stale.length, orphanedObjects: orphaned.length };
}
