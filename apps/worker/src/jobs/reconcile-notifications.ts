import { prisma } from '@machiya/db';
import { ENQUIRY_NOTIFY_GRACE_MINUTES, ENQUIRY_NOTIFY_MAX_ATTEMPTS } from '@machiya/shared';
import type { Queue } from 'bullmq';
import { logger } from '../logger.js';
import type { EnquiryNotificationJob } from './notify-enquiry.js';

const BATCH = 100;

/**
 * Drains enquiry notifications the enqueue missed.
 *
 * Exactly the image reconciler's shape (D40), because the hole is the same one:
 * the message commits to Postgres and the job goes to Redis, with no
 * transaction across them. If the enqueue throws — a Redis blip, a failover,
 * the API dying in the gap — the message is committed and nothing is coming for
 * it, and a lister never learns somebody wanted their flat.
 *
 * **Whether that is worth reconciling was the decision**, and the answer is
 * yes: an enquiry notification is the supply side's only signal that a seeker
 * is waiting, it is not idempotently retried by anything else, and the seeker
 * has no way to tell it was lost. A missed image job is visible to its owner as
 * a spinner; a missed notification is invisible to everybody.
 *
 * No outbox table, for the same reason D40 gives: `EnquiryMessage.notifyOwed`
 * plus `notifiedAt` already IS the durable record of intent, and the job id
 * already equals the message id, which makes the enqueue idempotent by
 * construction.
 */
export async function reconcileNotifications(
  queue: Queue<EnquiryNotificationJob>,
): Promise<{ scanned: number; enqueued: number; abandoned: number }> {
  const cutoff = new Date(Date.now() - ENQUIRY_NOTIFY_GRACE_MINUTES * 60_000);

  const owed = await prisma.enquiryMessage.findMany({
    where: {
      notifyOwed: true,
      notifiedAt: null,
      // A message committed a second ago is one whose enqueue is very likely in
      // flight. Racing it would send the same email twice.
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
    select: { id: true, notifyFails: true },
  });

  let enqueued = 0;
  let abandoned = 0;

  for (const message of owed) {
    if (message.notifyFails >= ENQUIRY_NOTIFY_MAX_ATTEMPTS) {
      await prisma.enquiryMessage.update({
        where: { id: message.id },
        data: { notifyOwed: false },
      });
      abandoned += 1;
      continue;
    }

    const existing = await queue.getJob(message.id);

    if (existing) {
      const state = await existing.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed') continue;

      // A finished or failed job keeps its id, and `add` with an existing id is
      // a SILENT no-op — so the corpse is removed before the id is reused.
      // Without this the row is stranded permanently, which is the exact bug
      // D40 exists to close.
      await existing.remove();
    }

    await queue.add('enquiry-message', { messageId: message.id }, { jobId: message.id });
    enqueued += 1;
  }

  if (enqueued > 0 || abandoned > 0) {
    logger.warn(
      { scanned: owed.length, enqueued, abandoned },
      'reconciled enquiry notifications the enqueue missed',
    );
  }

  return { scanned: owed.length, enqueued, abandoned };
}
