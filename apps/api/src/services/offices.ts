import { prisma } from '@machiya/db';
import {
  MAX_OFFICES_PER_USER,
  officeInputSchema,
  officePatchSchema,
  type Office,
} from '@machiya/shared';
import { HttpError } from '../middleware/error-handler.js';
import type { RequestSession } from '../middleware/require-auth.js';

/**
 * Saved offices, per signed-in user.
 *
 * `location` is derived from lat/lng by the same trigger as every other geo
 * model, so nothing here writes the geography column — see DECISIONS.md D2.
 */

const SELECT = {
  id: true,
  label: true,
  address: true,
  lat: true,
  lng: true,
  isDefault: true,
  createdAt: true,
} as const;

export async function listOffices(session: RequestSession): Promise<{ offices: Office[] }> {
  const offices = await prisma.officeLocation.findMany({
    where: { userId: session.userId },
    // The default first, then newest — the list doubles as the office picker.
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    select: SELECT,
  });

  return { offices };
}

/**
 * Exactly one office is the default, and that is enforced here rather than by a
 * partial unique index: promoting one has to demote the others, which is two
 * statements, so it is a transaction either way.
 */
async function setDefault(userId: string, officeId: string): Promise<void> {
  await prisma.$transaction([
    prisma.officeLocation.updateMany({
      where: { userId, id: { not: officeId } },
      data: { isDefault: false },
    }),
    prisma.officeLocation.update({ where: { id: officeId }, data: { isDefault: true } }),
  ]);
}

export async function createOffice(session: RequestSession, body: unknown): Promise<Office> {
  const input = officeInputSchema.parse(body);

  const existing = await prisma.officeLocation.count({ where: { userId: session.userId } });

  if (existing >= MAX_OFFICES_PER_USER) {
    throw new HttpError(
      409,
      'too_many_offices',
      `You can keep up to ${String(MAX_OFFICES_PER_USER)} offices — remove one first`,
    );
  }

  const office = await prisma.officeLocation.create({
    data: {
      userId: session.userId,
      label: input.label,
      address: input.address,
      lat: input.lat,
      lng: input.lng,
      // The first office saved is the default whether or not they asked, because
      // an account with offices and no default has no sensible starting view.
      isDefault: input.isDefault || existing === 0,
    },
    select: SELECT,
  });

  if (office.isDefault) {
    await setDefault(session.userId, office.id);
  }

  return office;
}

/** Loads an office and proves it belongs to the caller. */
async function loadOwned(session: RequestSession, officeId: string): Promise<{ id: string }> {
  const office = await prisma.officeLocation.findUnique({
    where: { id: officeId },
    select: { id: true, userId: true },
  });

  // 404 rather than 403: whether an office id exists is not the caller's
  // business, and an admin has no reason to edit someone's saved office.
  if (!office || office.userId !== session.userId) {
    throw new HttpError(404, 'office_not_found', 'No such office');
  }

  return { id: office.id };
}

export async function patchOffice(
  session: RequestSession,
  officeId: string,
  body: unknown,
): Promise<Office> {
  await loadOwned(session, officeId);
  const input = officePatchSchema.parse(body);

  const office = await prisma.officeLocation.update({
    where: { id: officeId },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.lat !== undefined ? { lat: input.lat } : {}),
      ...(input.lng !== undefined ? { lng: input.lng } : {}),
    },
    select: SELECT,
  });

  if (input.isDefault) {
    await setDefault(session.userId, officeId);
    return { ...office, isDefault: true };
  }

  return office;
}

export async function deleteOffice(
  session: RequestSession,
  officeId: string,
): Promise<{ id: string }> {
  await loadOwned(session, officeId);

  const removed = await prisma.officeLocation.delete({
    where: { id: officeId },
    select: { isDefault: true },
  });

  // Deleting the default leaves the account without one, so promote the newest
  // survivor rather than making the next search start from nowhere.
  if (removed.isDefault) {
    const next = await prisma.officeLocation.findFirst({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (next) {
      await setDefault(session.userId, next.id);
    }
  }

  return { id: officeId };
}
