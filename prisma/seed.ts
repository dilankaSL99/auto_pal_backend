import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Standard garage trackers seeded on every new vehicle. Mirrors the Flutter
// app's `_allDefaultTrackerNames` (utils/tracker_defaults.dart) so the demo
// account matches what an in-app-created vehicle gets.
const DEFAULT_TRACKERS = [
  'Battery',
  'Engine Oil',
  'Gear Oil',
  'Spark plugs',
  'Timing Belt',
  'Tire Rotation',
  'Wheel alignment',
];

// Creates a demo account you can log in with:
//   email: demo@autopal.app   password: password123
async function main() {
  const email = 'demo@autopal.app';
  const passwordHash = await bcrypt.hash('password123', 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash, displayName: 'Demo Driver' },
  });

  const existing = await prisma.vehicle.findFirst({ where: { userId: user.id } });
  if (!existing) {
    await prisma.vehicle.create({
      data: {
        userId: user.id,
        type: 'petrol',
        vehicleType: 'car',
        make: 'Toyota',
        model: 'Prius',
        year: 2019,
        licensePlate: 'CAC 8515',
        currentMileage: 119286,
        nickname: 'Daily Driver',
        trackers: {
          create: DEFAULT_TRACKERS.map((name) => ({ name })),
        },
        fuelRecords: {
          create: [
            {
              userId: user.id,
              date: new Date(),
              liters: 20,
              fuelType: 'Petrol 92',
              odometer: 119286,
              pricePerLiter: 340,
              isFullTank: true,
            },
          ],
        },
      },
    });
  }

  // Top up default trackers on the demo vehicle so re-running the seed heals an
  // older demo record that predates the full default set (idempotent).
  const vehicle =
    existing ?? (await prisma.vehicle.findFirst({ where: { userId: user.id } }));
  if (vehicle) {
    const have = new Set(
      (
        await prisma.trackerItem.findMany({
          where: { vehicleId: vehicle.id },
          select: { name: true },
        })
      ).map((t) => t.name),
    );
    const missing = DEFAULT_TRACKERS.filter((name) => !have.has(name));
    if (missing.length > 0) {
      await prisma.trackerItem.createMany({
        data: missing.map((name) => ({ name, vehicleId: vehicle.id })),
      });
      // eslint-disable-next-line no-console
      console.log(`Added ${missing.length} default tracker(s): ${missing.join(', ')}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded demo user: ${email} / password123`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
