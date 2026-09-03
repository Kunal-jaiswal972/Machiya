import { prisma } from '@machiya/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileImages } from '../src/jobs/reconcile-images.js';
import type { ProcessImageJob } from '../src/jobs/process-image.js';

/**
 * The hole this closes: the API commits a PENDING ListingImage row and then
 * enqueues, and those are two systems with no transaction between them. These
 * tests reproduce that exactly — a committed row with nothing in the queue —
 * and assert the reconciler drains it.
 *
 * Real Postgres and real Redis. The one substitution is the job processor:
 * derivation itself needs sharp and object storage and is already covered by
 * `packages/shared/test/derive.test.ts` and the API's image tests, so the
 * processor here stands in for it and marks the row READY. What is under test is
 * the drain, not the resize.
 */
const QUEUE_NAME = 'images-reconcile-test';

let connection: Redis;
let queue: Queue<ProcessImageJob>;
let listingId: string;

beforeAll(async () => {
  connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  queue = new Queue<ProcessImageJob>(QUEUE_NAME, { connection });
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await queue.obliterate({ force: true });

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingImage", "Listing", "User", "City" RESTART IDENTITY CASCADE
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

  const owner = await prisma.user.create({
    data: { email: 'owner@test.local', name: 'Owner', role: 'LISTER', emailVerified: true },
  });

  const listing = await prisma.listing.create({
    data: {
      slug: 'patna-test-listing-abc123',
      ownerId: owner.id,
      cityId: city.id,
      title: 'Test listing',
      description: 'For the reconciler tests.',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'UNFURNISHED',
      address: 'Boring Road, Patna',
      locality: 'Boring Road',
      lat: 25.6127,
      lng: 85.1145,
      bedrooms: 2,
      bathrooms: 1,
      areaSqft: 900,
      rentAmount: 14_000,
    },
  });

  listingId = listing.id;
});

/**
 * The exact failure being fixed: the row commits, the enqueue does not happen.
 * `createdAt` is backdated past the grace period, because a row committed a
 * second ago is one whose enqueue may still be in flight.
 */
async function commitPendingRowWithoutEnqueueing(options: { ageMs?: number } = {}) {
  const image = await prisma.listingImage.create({
    data: {
      listingId,
      objectKey: `originals/${listingId}/orphan.jpg`,
      variantBaseKey: `variants/${listingId}/orphan`,
      status: 'PENDING',
      width: 0,
      height: 0,
    },
  });

  const ageMs = options.ageMs ?? 5 * 60 * 1000;
  return prisma.listingImage.update({
    where: { id: image.id },
    data: { createdAt: new Date(Date.now() - ageMs) },
  });
}

/** Stands in for derivation. Marks the row READY, as the real job would. */
function startProcessor(): Worker {
  return new Worker<ProcessImageJob>(
    QUEUE_NAME,
    async (job) => {
      await prisma.listingImage.update({
        where: { id: job.data.imageId },
        data: { status: 'READY', width: 1200, height: 800, processedAt: new Date() },
      });
    },
    { connection: connection.duplicate() },
  );
}

async function waitForStatus(imageId: string, status: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.listingImage.findUniqueOrThrow({ where: { id: imageId } });
    if (row.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return prisma.listingImage.findUniqueOrThrow({ where: { id: imageId } });
}

describe('reconcileImages', () => {
  let processor: Worker | undefined;

  afterEach(async () => {
    await processor?.close();
    processor = undefined;
  });

  it('drains a committed PENDING row that was never enqueued, all the way to READY', async () => {
    const image = await commitPendingRowWithoutEnqueueing();
    processor = startProcessor();

    const result = await reconcileImages(queue);

    expect(result).toMatchObject({ examined: 1, enqueued: 1, alreadyQueued: 0, exhausted: 0 });

    const settled = await waitForStatus(image.id, 'READY');
    expect(settled.status).toBe('READY');
    expect(settled.width).toBe(1200);
  });

  it('leaves a row alone while its job is still waiting', async () => {
    const image = await commitPendingRowWithoutEnqueueing();

    // No processor running, so the job stays in `waiting`.
    await queue.add(
      'process-image',
      { listingId, imageId: image.id, objectKey: image.objectKey ?? '' },
      { jobId: image.id },
    );

    const result = await reconcileImages(queue);

    expect(result).toMatchObject({ examined: 1, enqueued: 0, alreadyQueued: 1 });
    // Untouched: re-queueing a row that is already queued would resize twice.
    const row = await prisma.listingImage.findUniqueOrThrow({ where: { id: image.id } });
    expect(row.reconcileAttempts).toBe(0);
  });

  it('ignores a row inside the grace period, whose enqueue may be in flight', async () => {
    await commitPendingRowWithoutEnqueueing({ ageMs: 5_000 });

    const result = await reconcileImages(queue);

    expect(result.examined).toBe(0);
    expect(result.enqueued).toBe(0);
  });

  it('ignores rows that are already in a terminal state', async () => {
    for (const status of ['READY', 'REJECTED', 'FAILED'] as const) {
      const image = await commitPendingRowWithoutEnqueueing();
      await prisma.listingImage.update({ where: { id: image.id }, data: { status } });
    }

    const result = await reconcileImages(queue);

    expect(result.examined).toBe(0);
  });

  it('ignores a row whose original has been discarded', async () => {
    const image = await commitPendingRowWithoutEnqueueing();
    await prisma.listingImage.update({ where: { id: image.id }, data: { objectKey: null } });

    const result = await reconcileImages(queue);

    // Nothing to process, and the cleanup sweep owns these.
    expect(result.examined).toBe(0);
  });

  it('re-enqueues past a finished job left behind under the same id', async () => {
    const image = await commitPendingRowWithoutEnqueueing();

    // A job that ran to completion without the row reaching a terminal state —
    // the process died between the resize and the database update. BullMQ keeps
    // finished jobs, and `add` with an existing id is a silent no-op, so the
    // reconciler has to remove the corpse first or the row is stranded forever.
    // This is the one case where re-enqueueing is NOT idempotent on its own.
    const inertProcessor = new Worker<ProcessImageJob>(QUEUE_NAME, async () => undefined, {
      connection: connection.duplicate(),
    });

    await queue.add(
      'process-image',
      { listingId, imageId: image.id, objectKey: image.objectKey ?? '' },
      { jobId: image.id },
    );

    const deadline = Date.now() + 10_000;
    let state: string | undefined;
    while (Date.now() < deadline) {
      state = await (await queue.getJob(image.id))?.getState();
      if (state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await inertProcessor.close();
    expect(state).toBe('completed');

    // The row is still PENDING, and the job id is taken.
    const stranded = await prisma.listingImage.findUniqueOrThrow({ where: { id: image.id } });
    expect(stranded.status).toBe('PENDING');

    processor = startProcessor();
    const result = await reconcileImages(queue);

    expect(result.enqueued).toBe(1);
    const settled = await waitForStatus(image.id, 'READY');
    expect(settled.status).toBe('READY');
  });

  it('fails a row that has been reconciled too many times, with a reason', async () => {
    const image = await commitPendingRowWithoutEnqueueing();
    await prisma.listingImage.update({
      where: { id: image.id },
      data: { reconcileAttempts: 5 },
    });

    const result = await reconcileImages(queue, { maxAttempts: 5 });

    expect(result).toMatchObject({ examined: 1, enqueued: 0, exhausted: 1 });

    const row = await prisma.listingImage.findUniqueOrThrow({ where: { id: image.id } });
    expect(row.status).toBe('FAILED');
    // A dead end the user can act on, not an empty spinner.
    expect(row.failureReason).toMatch(/upload it again/i);
    expect(row.processedAt).not.toBeNull();
  });

  it('counts an attempt on every re-enqueue, so the ceiling is reachable', async () => {
    const image = await commitPendingRowWithoutEnqueueing();

    await reconcileImages(queue);
    const after = await prisma.listingImage.findUniqueOrThrow({ where: { id: image.id } });

    expect(after.reconcileAttempts).toBe(1);
  });

  it('bounds the batch and takes the oldest first', async () => {
    const older = await commitPendingRowWithoutEnqueueing({ ageMs: 60 * 60 * 1000 });
    await commitPendingRowWithoutEnqueueing({ ageMs: 10 * 60 * 1000 });
    await commitPendingRowWithoutEnqueueing({ ageMs: 5 * 60 * 1000 });

    const result = await reconcileImages(queue, { batchSize: 1 });

    expect(result).toMatchObject({ examined: 1, enqueued: 1 });
    expect(await queue.getJob(older.id)).toBeDefined();
  });

  it('is a no-op when there is nothing to reconcile, which is the normal case', async () => {
    const result = await reconcileImages(queue);

    expect(result).toEqual({ examined: 0, enqueued: 0, alreadyQueued: 0, exhausted: 0 });
  });
});
