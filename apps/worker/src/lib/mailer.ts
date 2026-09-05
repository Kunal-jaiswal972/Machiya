import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * The worker's own SMTP transport.
 *
 * A second copy of the API's rather than a shared one, deliberately: the two
 * processes have different environments and different failure policies, and
 * `@machiya/shared` must stay importable from the browser bundle — a mail
 * transport there would drag nodemailer into it.
 *
 * Unlike the API's, this one THROWS. A verification email that fails must not
 * fail the sign-up that triggered it, so that transport swallows; an enquiry
 * notification failing is the whole job, and BullMQ's retry is the right
 * response. See DECISIONS.md D68.
 */
let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  transporter ??= createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
  });
  return transporter;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail(input: SendMailInput): Promise<{ messageId: string }> {
  const info = await getTransporter().sendMail({
    from: env.MAIL_FROM,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
  });

  logger.info({ to: input.to, subject: input.subject, messageId: info.messageId }, 'mail sent');
  return { messageId: info.messageId };
}

export async function closeMailer(): Promise<void> {
  transporter?.close();
  transporter = undefined;
}
