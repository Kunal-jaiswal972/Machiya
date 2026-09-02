import { sendMail } from '../lib/mailer.js';

/**
 * Transactional email copy, in one place.
 *
 * Plain text is the source of truth and the HTML mirrors it, so the mail reads
 * the same in MailHog, in a text-only client, and in Gmail.
 */
function layout(heading: string, body: string, actionUrl: string, actionLabel: string): string {
  return `<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #16202e;">
    <h1 style="font-size: 20px;">${heading}</h1>
    <p>${body}</p>
    <p>
      <a href="${actionUrl}"
         style="display: inline-block; padding: 10px 16px; background: #2563eb;
                color: #fff; border-radius: 8px; text-decoration: none;">
        ${actionLabel}
      </a>
    </p>
    <p style="font-size: 13px; color: #64748b;">
      If the button does not work, paste this into your browser:<br />
      <span style="word-break: break-all;">${actionUrl}</span>
    </p>
    <p style="font-size: 13px; color: #64748b;">
      Did not expect this email? You can ignore it — nothing changes until the
      link is used.
    </p>
  </body>
</html>`;
}

export async function sendVerificationEmail(input: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  await sendMail({
    to: input.to,
    subject: 'Verify your Machiya email address',
    text: [
      `Hi ${input.name},`,
      '',
      'Confirm your email address to finish setting up your Machiya account:',
      input.url,
      '',
      'The link is valid for one hour. If you did not sign up, ignore this email.',
    ].join('\n'),
    html: layout(
      `Hi ${input.name},`,
      'Confirm your email address to finish setting up your Machiya account. The link is valid for one hour.',
      input.url,
      'Verify email address',
    ),
  });
}

export async function sendPasswordResetEmail(input: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  await sendMail({
    to: input.to,
    subject: 'Reset your Machiya password',
    text: [
      `Hi ${input.name},`,
      '',
      'Use this link to choose a new password:',
      input.url,
      '',
      'The link is valid for one hour and can be used once. If you did not ask',
      'for a reset, ignore this email — your password stays as it is.',
    ].join('\n'),
    html: layout(
      `Hi ${input.name},`,
      'Use the button below to choose a new password. The link is valid for one hour and can be used once.',
      input.url,
      'Choose a new password',
    ),
  });
}
