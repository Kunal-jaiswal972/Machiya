import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * SMTP transport, pointed at MailHog in development so every verification and
 * reset link is readable offline at http://localhost:8025 without a mail
 * provider account.
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

/**
 * Never throws. A failed verification email must not fail the sign-up request
 * that triggered it — the user can ask for another one, and the failure belongs
 * in the logs, not in a 500.
 */
export async function sendMail(input: SendMailInput): Promise<{ sent: boolean }> {
  try {
    const info = await getTransporter().sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    });

    logger.info({ to: input.to, subject: input.subject, messageId: info.messageId }, 'mail sent');
    return { sent: true };
  } catch (error) {
    logger.error({ err: error, to: input.to, subject: input.subject }, 'mail send failed');
    return { sent: false };
  }
}
