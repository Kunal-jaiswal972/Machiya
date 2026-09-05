import { prisma } from '@machiya/db';
import { ENQUIRY_NOTIFY_MAX_ATTEMPTS } from '@machiya/shared';
import type { Job } from 'bullmq';
import { env } from '../env.js';
import { sendMail } from '../lib/mailer.js';
import { logger } from '../logger.js';

export interface EnquiryNotificationJob {
  messageId: string;
}

/**
 * Emails the other party about one enquiry message.
 *
 * Sends from the worker rather than the request path for the same reason image
 * derivation lives here (D34): a slow SMTP server must not hold a request open,
 * and a lister's mail provider is not something this product controls.
 *
 * Idempotent on `notifiedAt`. The job id is the message id, so a redelivery or
 * a reconciler racing the original enqueue collapses onto one job — but BullMQ
 * can still run a job twice after a hard kill, so the row is checked as well.
 */
export async function notifyEnquiry(job: Job<EnquiryNotificationJob>): Promise<{ sent: boolean }> {
  const message = await prisma.enquiryMessage.findUnique({
    where: { id: job.data.messageId },
    include: {
      sender: { select: { id: true, name: true } },
      enquiry: {
        select: {
          id: true,
          seekerId: true,
          listerId: true,
          seeker: { select: { email: true, name: true } },
          lister: { select: { email: true, name: true } },
          listing: { select: { slug: true, title: true, locality: true } },
        },
      },
    },
  });

  if (!message) {
    // The thread was deleted between the enqueue and now. Nothing to send and
    // nothing wrong.
    return { sent: false };
  }

  if (message.notifiedAt !== null || !message.notifyOwed) {
    return { sent: false };
  }

  const { enquiry } = message;
  const senderIsLister = message.senderId === enquiry.listerId;
  const recipient = senderIsLister ? enquiry.seeker : enquiry.lister;
  const listingName = enquiry.listing.title ?? 'your listing';

  const url = `${env.WEB_APP_URL}/enquiries/${enquiry.id}`;
  const subject = senderIsLister
    ? `${message.sender.name} replied about ${listingName}`
    : `New enquiry about ${listingName}`;

  const text = [
    `${message.sender.name} wrote:`,
    '',
    message.body,
    '',
    `About: ${listingName}${enquiry.listing.locality ? ` — ${enquiry.listing.locality}` : ''}`,
    `Reply: ${url}`,
    '',
    // Says the rule rather than leaving someone to guess why they got one email
    // for four replies. See DECISIONS.md D68.
    'We only email you about the first message in a conversation, and again if a',
    'quiet thread starts up. Replies within a conversation will not fill your inbox.',
  ].join('\n');

  await sendMail({ to: recipient.email, subject, text });

  await prisma.enquiryMessage.update({
    where: { id: message.id },
    data: { notifiedAt: new Date() },
  });

  logger.info({ messageId: message.id, enquiryId: enquiry.id }, 'enquiry notification sent');
  return { sent: true };
}

/**
 * Called once BullMQ has exhausted its retries.
 *
 * The message stops being owed a mail rather than staying owed forever: a row
 * the reconciler picks up on every run and cannot deliver is a loop, not a
 * safety net. The count is kept so a pattern of failures is visible.
 */
export async function markNotificationFailed(messageId: string): Promise<void> {
  try {
    const message = await prisma.enquiryMessage.update({
      where: { id: messageId },
      data: { notifyFails: { increment: 1 } },
      select: { notifyFails: true },
    });

    if (message.notifyFails >= ENQUIRY_NOTIFY_MAX_ATTEMPTS) {
      await prisma.enquiryMessage.update({
        where: { id: messageId },
        data: { notifyOwed: false },
      });
      logger.error(
        { messageId, attempts: message.notifyFails },
        'giving up on an enquiry notification',
      );
    }
  } catch (error) {
    logger.error({ err: error, messageId }, 'could not record a notification failure');
  }
}
