import { prisma } from '../prisma';
import { ApiError } from './errors';

// Confirms a vehicle exists AND belongs to the given user. Used before any
// write to a vehicle-scoped resource (fuel, service, reminders, trackers) so a
// user can never touch another account's data. Returns the vehicle id.
export async function assertVehicleOwned(userId: string, vehicleId: string): Promise<string> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { id: true, userId: true },
  });
  if (!vehicle) throw ApiError.notFound('Vehicle not found');
  if (vehicle.userId !== userId) throw ApiError.forbidden('You do not own this vehicle');
  return vehicle.id;
}
