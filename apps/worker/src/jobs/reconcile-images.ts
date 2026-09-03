import { prisma } from '@machiya/db';
import type { Queue } from 'bullmq';
import { logger } from '../logger.js';
import type { ProcessImageJob } from './process-image.js';

export interface ReconcileResult {
  /** PENDING rows past the grace period that were examined. */
  examined: number;
  /** Rows with no job in the queue, which were enqueued. */
  enqueued: number;
  /** Rows already active, waiting or delayed — left alone. */
  alreadyQueued: number;
  /** Rows that had been re-enqueued too many times and were failed. */
  exhausted: number;
}

/**
 * Drains the dual write between Postgres and Redis.
 *
 * The API commits a PENDING `ListingImage` row and then enqueues. Those are two
 * systems and there is no transaction across them: if the enqueue throws, or the
 * process dies in the gap, the row is committed and nothing is coming for it.
 * Before this job existed, such a row sat as a spinner in the gallery until the
 * 24-hour cleanup sweep deleted it — the user's upload silently vanished.
 *
 * This is a reconciler, not an outbox. The PENDING row already IS the durable
 * record of intent, and the job id already equals the image id, so re-enqueueing
 * is idempotent by construction. What was missing was something to notice. See
 * DECISIONS.md D40.
 *
 * Three things keep it from doing harm:
 *
 *  - a grace period, so a row the API committed a second ago — whose enqueue is
 *    very likely in flight right now — is not raced.
 *  - a bounded batch, oldest first, so a backlog drains steadily instead of
 *    dumping thousands of jobs into a queue in one tick.
 *  - an attempt counter, so a row that keeps coming back without reaching a
 *    terminal state becomes FAILED with a reason rather than being retried
 *    forever. A permanently unprocessable row is a bug to see, not a loop.
 */
export interface ReconcileOptions {
  /** Ignore rows younger than this. Default 2 minutes. */
  graceMs?: number;
  /** Maximum rows handled per run. Default 100. */
  batchSize?: number;
  /** Re-enqueues before a row is failed. Default 5. */
  maxAttempts?: number;
}

export async function reconcileImages(
  queue: Queue<ProcessImageJob>,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const graceMs = options.graceMs ?? 2 * 60 * 1000;
  const batchSize = options.batchSize ?? 100;
  const maxAttempts = options.maxAttempts ?? 5;

  const cutoff = new Date(Date.now() - graceMs);

  const candidates = await prisma.listingImage.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: cutoff },
      // A row with no object key has nothing to process — the original was
      // discarded. The cleanup sweep owns those.
      objectKey: { not: null },
    },
    select: { id: true, listingId: true, objectKey: true, reconcileAttempts: true },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });

  const result: ReconcileResult = {
    examined: candidates.length,
    enqueued: 0,
    alreadyQueued: 0,
    exhausted: 0,
  };

  for (const row of candidates) {
    if (!row.objectKey) continue;

    // The job id IS the image id, so this asks directly whether work for this
    // row exists — no bookkeeping table, no scanning the queue.
    const existing = await queue.getJob(row.id);
    const state = existing ? await existing.getState() : undefined;

    if (
      state === 'active' ||
      state === 'waiting' ||
      state === 'delayed' ||
      state === 'waiting-children'
    ) {
      result.alreadyQueued += 1;
      continue;
    }

    if (row.reconcileAttempts >= maxAttempts) {
      // Give up loudly. Something about this row does not process, and quietly
      // re-queueing it forever hides that from everyone.
      await prisma.listingImage.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          failureReason: 'We could not process this photo — please upload it again',
          processedAt: new Date(),
        },
      });
      result.exhausted += 1;
      logger.error(
        { imageId: row.id, listingId: row.listingId, attempts: row.reconcileAttempts },
        'image failed after repeated reconciliation',
      );
      continue;
    }

    // A completed or failed job left behind by an earlier attempt has to go
    // before the same id can be added again — BullMQ keeps finished jobs, and
    // `add` with an existing id is a silent no-op.
    if (existing) {
      await existing.remove();
    }

    await prisma.listingImage.update({
      where: { id: row.id },
      data: { reconcileAttempts: { increment: 1 } },
    });

    await queue.add(
      'process-image',
      { listingId: row.listingId, imageId: row.id, objectKey: row.objectKey },
      { jobId: row.id },
    );

    result.enqueued += 1;
  }

  if (result.enqueued > 0 || result.exhausted > 0) {
    logger.warn(result, 'reconciled orphaned pending images');
  }

  return result;
}
