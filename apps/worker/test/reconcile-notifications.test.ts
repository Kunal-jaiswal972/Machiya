import { prisma } from '@machiya/db';
import { ENQUIRY_NOTIFY_GRACE_MINUTES, ENQUIRY_NOTIFY_MAX_ATTEMPTS } from '@machiya/shared';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileNotifications } from '../src/jobs/reconcile-notifications.js';
import type { EnquiryNotificationJob } from '../src/jobs/notify-enquiry.js';

/**
 * Against real Postgres and real Redis, for the reason D40's image reconciler
 * test gives: a mocked queue would prove nothing about `getJob`, job states or
 * id collisions, and that is precisely where the bug lives.
 *
 * The processor is the one substitution. Sending mail is covered by the job's
 * own path; what needs testing here is whether a message owed a notification
 * that nothing is working on gets one.
 */
const QUEUE_NAME = 'test-notifications';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

let queue: Queue<EnquiryNotificationJob>;
let worker: Worker | undefined;
let seekerId: string;
let listerId: string;
let listingId: string;
let enquiryId: string;

async function resetWorld(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "EnquiryMessage", "Enquiry", "ListingImage", "Listing",
      "Locality", "User", "City" RESTART IDENTITY CASCADE
  `);

  const city = await prisma.city.create({
    data: {
      slug: 'patna',
      name: 'Patna',
      state: 'Bihar',
      centroidLat: 25.5941,
      centroidLng: 85.1376,
      bbox: { minLng: 84.95, minLat: 25.5, maxLng: 85.3, maxLat: 25.68 },
    },
  });

  const [seeker, lister] = await Promise.all([
    prisma.user.create({
      data: { email: 'seeker@test.local', name: 'Seeker', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: 'lister@test.local', name: 'Lister', role: 'EDITOR', emailVerified: true },
    }),
  ]);

  seekerId = seeker.id;
  listerId = lister.id;

  const listing = await prisma.listing.create({
    data: {
      slug: 'patna-notify-test-aaa111',
      ownerId: lister.id,
      cityId: city.id,
      title: 'A flat to be asked about',
      description: 'Exists so an enquiry has somewhere to point.',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'UNFURNISHED',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      address: 'Boring Road, Patna',
      locality: 'Boring Road',
      lat: 25.6127,
      lng: 85.1588,
      bedrooms: 2,
      bathrooms: 1,
      areaSqft: 900,
      rentAmount: 15_000,
    },
  });

  listingId = listing.id;

  const enquiry = await prisma.enquiry.create({
    data: { listingId, seekerId, listerId },
  });

  enquiryId = enquiry.id;
}

/** Older than the grace window, so the reconciler will look at it. */
function longEnoughAgo(): Date {
  return new Date(Date.now() - (ENQUIRY_NOTIFY_GRACE_MINUTES + 1) * 60_000);
}

beforeEach(async () => {
  await resetWorld();
  queue = new Queue<EnquiryNotificationJob>(QUEUE_NAME, { connection });
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await worker?.close();
  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
});

describe('reconcileNotifications', () => {
  it('delivers a message whose enqueue never happened', async () => {
    // The exact hole: the row is committed and nothing is coming for it.
    const message = await prisma.enquiryMessage.create({
      data: {
        enquiryId,
        senderId: seekerId,
        body: 'Is this still available?',
        notifyOwed: true,
        createdAt: longEnoughAgo(),
      },
    });

    const result = await reconcileNotifications(queue);

    expect(result.enqueued).toBe(1);
    const job = await queue.getJob(message.id);
    expect(job?.data.messageId).toBe(message.id);
  });

  it('leaves alone a message whose job is already waiting', async () => {
    const message = await prisma.enquiryMessage.create({
      data: {
        enquiryId,
        senderId: seekerId,
        body: 'Already queued',
        notifyOwed: true,
        createdAt: longEnoughAgo(),
      },
    });

    await queue.add('enquiry-message', { messageId: message.id }, { jobId: message.id });

    const result = await reconcileNotifications(queue);
    expect(result.enqueued).toBe(0);
  });

  it('ignores a message younger than the grace window', async () => {
    // Its enqueue is very likely in flight; racing it would send two emails.
    await prisma.enquiryMessage.create({
      data: { enquiryId, senderId: seekerId, body: 'Just now', notifyOwed: true },
    });

    const result = await reconcileNotifications(queue);
    expect(result.scanned).toBe(0);
  });

  it('ignores a message that was never owed a mail', async () => {
    await prisma.enquiryMessage.create({
      data: {
        enquiryId,
        senderId: seekerId,
        body: 'A reply inside an active conversation',
        notifyOwed: false,
        createdAt: longEnoughAgo(),
      },
    });

    const result = await reconcileNotifications(queue);
    expect(result.scanned).toBe(0);
  });

  it('ignores one that has already been sent', async () => {
    await prisma.enquiryMessage.create({
      data: {
        enquiryId,
        senderId: seekerId,
        body: 'Already delivered',
        notifyOwed: true,
        notifiedAt: new Date(),
        createdAt: longEnoughAgo(),
      },
    });

    const result = await reconcileNotifications(queue);
    expect(result.scanned).toBe(0);
  });

  /**
   * The case that is NOT idempotent on its own, and the reason D40's reconciler
   * removes the corpse: BullMQ keeps finished jobs, and `add` with an existing
   * id is a SILENT no-op. Without the removal the row is stranded forever.
   */
  it('re-enqueues past a finished job that left the row unsent', async () => {
    const message = await prisma.enquiryMessage.create({
      data: {
        enquiryId,
        senderId: seekerId,
        body: 'The process died between the send and the update',
        notifyOwed: true,
        createdAt: longEnoughAgo(),
      },
    });

    // Run a job to completion under that id without touching the row.
    worker = new Worker(QUEUE_NAME, async () => ({ ok: true }), { connection });
    await queue.add('enquiry-message', { messageId: message.id }, { jobId: message.id });

    await new Promise<void>((resolve) => {
      worker?.on('completed', () => {
        resolve();
      });
    });

    const naive = await queue.add(
      'enquiry-message',
      { messageId: message.id },
      { jobId: message.id },
    );
    // Proves the premise rather than assuming it: the second add did nothing.
    expect(await naive.getState()).toBe('completed');

    await worker.close();
    worker = undefined;

    const result = await reconcileNotifications(queue);
    expect(result.enqueued).toBe(1);
    expect(await (await queue.getJob(message.id))?.getState()).not.toBe('completed');
  });

  it('gives up on a message that has failed too many times', async () => {
    const message = await prisma.enquiryMessage.create({
      data: {
        enquiryId,
        senderId: seekerId,
        body: 'Undeliverable',
        notifyOwed: true,
        notifyFails: ENQUIRY_NOTIFY_MAX_ATTEMPTS,
        createdAt: longEnoughAgo(),
      },
    });

    const result = await reconcileNotifications(queue);

    expect(result.abandoned).toBe(1);
    expect(result.enqueued).toBe(0);

    // A row the reconciler picks up every run and cannot deliver is a loop,
    // not a safety net.
    const after = await prisma.enquiryMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(after.notifyOwed).toBe(false);
  });
});
