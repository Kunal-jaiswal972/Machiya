import { prisma } from '@machiya/db';
import { profileUpdateSchema, sessionUserSchema, type SessionUser } from '@machiya/shared';
import { logger } from '../logger.js';
import type { RequestSession } from '../middleware/require-auth.js';

/**
 * The account the signed-in person owns: their own details, and the end of it.
 *
 * Name and phone are written here rather than through Better Auth's
 * `updateUser`, because `phone` is declared with `input: false` — the auth
 * endpoint refuses to write it, by design, so that a sign-up payload cannot set
 * a field the product treats as contact information.
 */
/**
 * The account row, not the session's copy of it.
 *
 * Sessions are cached — five minutes in the cookie, and in Redis behind that —
 * so serving `session.user` here returned the name and phone as they were when
 * the session was minted. Saving a phone number and reloading showed the field
 * empty until the cache expired.
 */
export async function getProfile(session: RequestSession): Promise<{ user: SessionUser }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });

  return { user: sessionUserSchema.parse(user) };
}

export async function updateProfile(
  session: RequestSession,
  body: unknown,
): Promise<{ user: SessionUser }> {
  const patch = profileUpdateSchema.parse(body);

  const user = await prisma.user.update({
    where: { id: session.userId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      // Changing the number un-verifies it: the old verification was of a
      // number this account no longer claims.
      ...(patch.phone !== undefined ? { phone: patch.phone, isPhoneVerified: false } : {}),
    },
  });

  return { user: sessionUserSchema.parse(user) };
}

/**
 * Deleting an account: the row survives, scrubbed.
 *
 * A hard delete cascades through `Enquiry` on both sides, so a lister leaving
 * would erase the seeker's copy of a conversation the seeker is party to, and
 * every listing anyone had favourited. What the person is owed is that their
 * details stop being their details — so the personal fields go, the credentials
 * and sessions go, their listings come down, and the threads stay, attributed
 * to an account with no one behind it. See DECISIONS.md D80.
 */
export async function deleteAccount(session: RequestSession): Promise<{ deletedAt: Date }> {
  const deletedAt = new Date();

  await prisma.$transaction(async (tx) => {
    // Published listings come down; drafts are already invisible and stay as
    // they are. PAUSED is the product's "not visible, not gone" state, and a
    // paused listing keeps the enquiry threads hanging off it readable.
    await tx.listing.updateMany({
      where: { ownerId: session.userId, status: 'PUBLISHED' },
      data: { status: 'PAUSED' },
    });

    await tx.favorite.deleteMany({ where: { userId: session.userId } });
    await tx.savedSearch.deleteMany({ where: { userId: session.userId } });
    await tx.officeLocation.deleteMany({ where: { userId: session.userId } });

    // Credentials and sessions, not just the profile: leaving an `Account` row
    // behind would leave a password hash for an account nobody can reach.
    await tx.account.deleteMany({ where: { userId: session.userId } });
    await tx.session.deleteMany({ where: { userId: session.userId } });

    await tx.user.update({
      where: { id: session.userId },
      data: {
        deletedAt,
        name: 'Deleted account',
        // Unique, so it cannot collide with another deletion, and on a domain
        // reserved by RFC 6761 so it can never be mailed.
        email: `deleted-${session.userId}@machiya.invalid`,
        emailVerified: false,
        phone: null,
        isPhoneVerified: false,
        avatarUrl: null,
        commutePrefs: undefined,
        // The admin plugin refuses a sign-in for a banned user, which is what
        // stops a social provider from recreating the session on the same id.
        banned: true,
        banReason: 'Account deleted by its owner',
      },
    });
  });

  logger.info({ userId: session.userId }, 'account deleted by its owner');

  return { deletedAt };
}
