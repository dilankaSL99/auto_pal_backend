import type { UserTier } from '@prisma/client';
import { prisma } from '../prisma';
import { assertWithinLimit, limitsForTier } from './entitlements';

// Per-request quota checks for the direct create paths. Tier is read from the
// DB (never trusted from the token) so a plan change takes effect immediately.
//
// These run just before a write, outside a transaction — a rare concurrent
// double-create could momentarily exceed a cap by one. That's an acceptable
// trade for a usage quota (not an access-control boundary); tighten with a
// transactional count if it ever matters.

async function tierOf(userId: string): Promise<UserTier> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true },
  });
  return user?.tier ?? 'free';
}

export async function assertCanAddVehicle(userId: string): Promise<void> {
  const [tier, count] = await Promise.all([
    tierOf(userId),
    prisma.vehicle.count({ where: { userId } }),
  ]);
  assertWithinLimit(count, limitsForTier(tier).maxVehicles, 'vehicles', tier);
}

export async function assertCanAddTracker(userId: string, vehicleId: string): Promise<void> {
  const [tier, count] = await Promise.all([
    tierOf(userId),
    prisma.trackerItem.count({ where: { vehicleId } }),
  ]);
  assertWithinLimit(count, limitsForTier(tier).maxTrackersPerVehicle, 'trackers per vehicle', tier);
}

export async function assertCanAddReminder(userId: string): Promise<void> {
  const [tier, count] = await Promise.all([
    tierOf(userId),
    prisma.reminder.count({ where: { userId } }),
  ]);
  assertWithinLimit(count, limitsForTier(tier).maxReminders, 'reminders', tier);
}

export async function assertCanAddDocument(userId: string): Promise<void> {
  const [tier, count] = await Promise.all([
    tierOf(userId),
    prisma.document.count({ where: { userId } }),
  ]);
  assertWithinLimit(count, limitsForTier(tier).maxDocuments, 'documents', tier);
}
