import type { Prisma, PrismaClient } from '@prisma/client';

export type EntityType =
  | 'vehicle'
  | 'tracker'
  | 'fuelRecord'
  | 'serviceRecord'
  | 'reminder'
  | 'document'
  | 'driverLicense';

// Accepts either the base client or a transaction client, so the tombstone can
// be written atomically with the delete that produced it.
type Client = PrismaClient | Prisma.TransactionClient;

// Records (or refreshes) a deletion tombstone so offline clients pick it up on
// their next /sync.
export function recordTombstone(
  client: Client,
  userId: string,
  entityType: EntityType,
  entityId: string,
) {
  return client.tombstone.upsert({
    where: { userId_entityType_entityId: { userId, entityType, entityId } },
    create: { userId, entityType, entityId },
    update: { deletedAt: new Date() },
  });
}
