import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

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
          create: [{ name: 'Engine Oil' }, { name: 'Battery' }],
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
