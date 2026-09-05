import { prisma, type Prisma } from '@machiya/db';
import {
  ENQUIRY_NOTIFY_QUIET_HOURS,
  enquiryMessageInputSchema,
  enquiryStatusSchema,
  type EnquiryMessage,
  type EnquiryThread,
} from '@machiya/shared';
import { variantObjectKey } from '@machiya/shared/images';
import { z } from 'zod';
import { logger } from '../logger.js';
import { publicVariantUrl } from '../lib/storage.js';
import { enqueueEnquiryNotification } from '../lib/queues.js';
import { HttpError } from '../middleware/error-handler.js';
import type { RequestSession } from '../middleware/require-auth.js';

/**
 * Threaded messaging between a seeker and a lister, one thread per pair per
 * listing — which is what the `@@unique([listingId, seekerId])` constraint
 * already says, so starting an enquiry is an upsert rather than a create.
 *
 * Two rules are the substance of this module:
 *
 * **Contact details are masked until an enquiry exists.** Not "until you are
 * signed in" and not "until you click reveal": the number appears once the two
 * people are actually in a conversation, because that is the point at which the
 * lister has consented to being contacted by this person.
 *
 * **A notification is owed for the first message in a thread, and for the
 * first message after the thread has gone quiet.** See `notificationIsOwed`.
 */

const THREAD_INCLUDE = {
  seeker: { select: { id: true, name: true, phone: true, email: true } },
  lister: { select: { id: true, name: true, phone: true, email: true } },
  listing: {
    select: {
      id: true,
      slug: true,
      title: true,
      locality: true,
      rentAmount: true,
      salePrice: true,
      listingType: true,
      images: {
        where: { status: 'READY' },
        orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
        select: { variantBaseKey: true },
      },
    },
  },
} satisfies Prisma.EnquiryInclude;

type ThreadRow = Prisma.EnquiryGetPayload<{ include: typeof THREAD_INCLUDE }>;

/**
 * Should this message send an email?
 *
 * "First message in the thread" is the rule the brief names and it is not the
 * one people expect. A lister who replies four times in ten minutes should not
 * generate four emails to the seeker, and a seeker who comes back a week later
 * absolutely should generate one — so the rule is **first message in a while**,
 * with `ENQUIRY_NOTIFY_QUIET_HOURS` as "a while".
 *
 * Measured against the thread rather than against the recipient's inbox, so it
 * is a property of the conversation and needs no per-user state.
 */
export function notificationIsOwed(previousMessageAt: Date | null, now: Date): boolean {
  if (previousMessageAt === null) return true;
  const quietMs = ENQUIRY_NOTIFY_QUIET_HOURS * 3_600_000;
  return now.getTime() - previousMessageAt.getTime() >= quietMs;
}

function coverUrl(images: { variantBaseKey: string }[]): string | null {
  const base = images[0]?.variantBaseKey;
  return base ? publicVariantUrl(variantObjectKey(base, 'thumb', 'webp')) : null;
}

function toThread(
  row: ThreadRow,
  viewerId: string,
  unreadCount: number,
  preview: string | null,
): EnquiryThread {
  const viewerIsLister = row.listerId === viewerId;
  const counterpart = viewerIsLister ? row.seeker : row.lister;

  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    unreadCount,
    role: viewerIsLister ? 'lister' : 'seeker',
    // Unmasked, because reaching this function means a thread exists between
    // these two people. The masking lives on the LISTING read, not here.
    counterpart: {
      id: counterpart.id,
      name: counterpart.name,
      phone: counterpart.phone,
      email: counterpart.email,
    },
    listing: {
      id: row.listing.id,
      slug: row.listing.slug,
      title: row.listing.title,
      locality: row.listing.locality,
      rentAmount: row.listing.rentAmount,
      salePrice: row.listing.salePrice,
      listingType: row.listing.listingType,
      coverUrl: coverUrl(row.listing.images),
    },
    preview,
  };
}

async function loadThreadForViewer(session: RequestSession, enquiryId: string): Promise<ThreadRow> {
  const thread = await prisma.enquiry.findUnique({
    where: { id: enquiryId },
    include: THREAD_INCLUDE,
  });

  if (!thread) {
    throw new HttpError(404, 'enquiry_not_found', 'No such enquiry');
  }

  const isParty = thread.seekerId === session.userId || thread.listerId === session.userId;

  if (!isParty && session.role !== 'ADMIN') {
    // 404 rather than 403: whether a thread exists between two other people is
    // itself private.
    throw new HttpError(404, 'enquiry_not_found', 'No such enquiry');
  }

  return thread;
}

export async function listEnquiries(
  session: RequestSession,
  options: { role?: 'seeker' | 'lister' } = {},
) {
  const asSeeker = { seekerId: session.userId };
  const asLister = { listerId: session.userId };

  const where =
    options.role === 'seeker'
      ? asSeeker
      : options.role === 'lister'
        ? asLister
        : { OR: [asSeeker, asLister] };

  const rows = await prisma.enquiry.findMany({
    where,
    include: {
      ...THREAD_INCLUDE,
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true } },
      _count: {
        select: { messages: { where: { readAt: null, senderId: { not: session.userId } } } },
      },
    } satisfies Prisma.EnquiryInclude,
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
  });

  const threads = rows.map((row) =>
    toThread(row, session.userId, row._count.messages, row.messages[0]?.body ?? null),
  );

  return {
    threads,
    unreadTotal: threads.reduce((sum, thread) => sum + thread.unreadCount, 0),
  };
}

export async function getEnquiry(session: RequestSession, enquiryId: string) {
  const row = await loadThreadForViewer(session, enquiryId);

  const messages = await prisma.enquiryMessage.findMany({
    where: { enquiryId },
    orderBy: { createdAt: 'asc' },
    include: { sender: { select: { name: true } } },
  });

  const unread = messages.filter(
    (message) => message.readAt === null && message.senderId !== session.userId,
  ).length;

  return {
    thread: toThread(row, session.userId, unread, messages.at(-1)?.body ?? null),
    messages: messages.map((message): EnquiryMessage => ({
      id: message.id,
      senderId: message.senderId,
      senderName: message.sender.name,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      readAt: message.readAt?.toISOString() ?? null,
      mine: message.senderId === session.userId,
    })),
  };
}

/**
 * Starts a thread on a listing, or appends to the one that already exists.
 *
 * The listing has to be readable — a draft or a paused listing is not something
 * to open a conversation about — and a lister enquiring on their own listing is
 * refused rather than silently creating a thread with themselves.
 */
export async function createEnquiry(
  session: RequestSession,
  listingSlug: string,
  body: unknown,
): Promise<{ enquiryId: string }> {
  const input = enquiryMessageInputSchema.parse(body);

  const listing = await prisma.listing.findUnique({
    where: { slug: listingSlug },
    select: { id: true, ownerId: true, status: true },
  });

  if (!listing || listing.status !== 'PUBLISHED') {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  if (listing.ownerId === session.userId) {
    throw new HttpError(409, 'own_listing', 'That is your own listing');
  }

  const enquiry = await prisma.enquiry.upsert({
    where: { listingId_seekerId: { listingId: listing.id, seekerId: session.userId } },
    create: { listingId: listing.id, seekerId: session.userId, listerId: listing.ownerId },
    update: {},
    select: { id: true },
  });

  await appendMessage(session, enquiry.id, input.body);
  return { enquiryId: enquiry.id };
}

export async function replyToEnquiry(
  session: RequestSession,
  enquiryId: string,
  body: unknown,
): Promise<{ id: string }> {
  const input = enquiryMessageInputSchema.parse(body);
  await loadThreadForViewer(session, enquiryId);
  return appendMessage(session, enquiryId, input.body);
}

/**
 * Writes the message, decides whether a mail is owed, and enqueues it AFTER the
 * commit.
 *
 * Order matters and is the same as the image pipeline's (D40): the row is the
 * durable record of intent, so it is committed first; a failed enqueue is
 * logged and swallowed, because the reconciler will find the row and there is
 * nothing the sender could do differently. Telling them their message failed
 * when it is committed and about to be delivered would be false.
 */
async function appendMessage(
  session: RequestSession,
  enquiryId: string,
  body: string,
): Promise<{ id: string }> {
  const now = new Date();

  const previous = await prisma.enquiryMessage.findFirst({
    where: { enquiryId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const owed = notificationIsOwed(previous?.createdAt ?? null, now);

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.enquiryMessage.create({
      data: { enquiryId, senderId: session.userId, body, notifyOwed: owed },
      select: { id: true },
    });

    await tx.enquiry.update({
      where: { id: enquiryId },
      data: {
        lastMessageAt: now,
        // A lister answering moves the thread out of OPEN. A seeker writing
        // again does not reopen a thread the lister closed on purpose.
        ...((await isListerReply(tx, enquiryId, session.userId))
          ? { status: 'RESPONDED' as const }
          : {}),
      },
    });

    return created;
  });

  if (owed) {
    try {
      await enqueueEnquiryNotification({ messageId: message.id });
    } catch (error) {
      logger.error(
        { err: error, messageId: message.id, enquiryId },
        'enquiry notification enqueue failed after commit — leaving it for the reconciler',
      );
    }
  }

  return message;
}

async function isListerReply(
  tx: Pick<typeof prisma, 'enquiry'>,
  enquiryId: string,
  senderId: string,
): Promise<boolean> {
  const thread = await tx.enquiry.findUnique({
    where: { id: enquiryId },
    select: { listerId: true, status: true },
  });
  return thread?.listerId === senderId && thread.status === 'OPEN';
}

/** Marks every message from the other party as read. */
export async function markEnquiryRead(
  session: RequestSession,
  enquiryId: string,
): Promise<{ read: number }> {
  await loadThreadForViewer(session, enquiryId);

  const result = await prisma.enquiryMessage.updateMany({
    where: { enquiryId, readAt: null, senderId: { not: session.userId } },
    data: { readAt: new Date() },
  });

  return { read: result.count };
}

/**
 * Status is the LISTER's to set — it is their inbox being triaged.
 *
 * A seeker cannot mark their own enquiry as spam or closed, which would be a
 * way to hide it from the person it was sent to.
 */
const enquiryStatusInputSchema = z.object({ status: enquiryStatusSchema });

export async function setEnquiryStatus(
  session: RequestSession,
  enquiryId: string,
  body: unknown,
): Promise<{ id: string; status: string }> {
  const { status } = enquiryStatusInputSchema.parse(body);
  const thread = await loadThreadForViewer(session, enquiryId);

  if (thread.listerId !== session.userId && session.role !== 'ADMIN') {
    throw new HttpError(403, 'forbidden_owner', 'Only the listing owner can triage an enquiry');
  }

  await prisma.enquiry.update({ where: { id: enquiryId }, data: { status } });
  return { id: enquiryId, status };
}

/**
 * Does this viewer have a live conversation with the listing's owner?
 *
 * The single question behind "contact masked until an enquiry is sent", asked
 * by the listing detail read. A closed or spam-marked thread does not count:
 * the lister has ended the conversation, and the number goes back behind the
 * mask with it.
 */
export async function viewerHasEnquiry(
  viewerId: string | undefined,
  listingId: string,
): Promise<boolean> {
  if (!viewerId) return false;

  const existing = await prisma.enquiry.findFirst({
    where: {
      listingId,
      seekerId: viewerId,
      status: { in: ['OPEN', 'RESPONDED'] },
    },
    select: { id: true },
  });

  return existing !== null;
}
