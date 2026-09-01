/**
 * Grant or revoke the admin tier.
 *
 *   npm run role:set -- +15551234567 admin
 *   npm run role:set -- +15551234567 user
 *   npm run role:set -- --list
 *
 * Roles are not settable over the API by design: promotion is an
 * infrastructure action, not something a signed-in session can perform.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [phoneArg, roleArg] = process.argv.slice(2);

  if (phoneArg === '--list') {
    const admins = await prisma.user.findMany({
      where: { role: 'admin' },
      select: { phoneNumber: true, displayName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (admins.length === 0) {
      console.log('No admins yet. Grant one with:\n  npm run role:set -- +15551234567 admin');
    } else {
      console.log(`${admins.length} admin(s):`);
      for (const a of admins) console.log(`  ${a.phoneNumber}  (${a.displayName})`);
    }
    return;
  }

  if (!phoneArg || (roleArg !== 'admin' && roleArg !== 'user')) {
    console.error('Usage: npm run role:set -- <phoneNumber> <admin|user>');
    console.error('       npm run role:set -- --list');
    process.exitCode = 1;
    return;
  }

  const phoneNumber = phoneArg.trim();
  const existing = await prisma.user.findUnique({
    where: { phoneNumber },
    select: { id: true, role: true, displayName: true },
  });

  if (!existing) {
    console.error(`No account found for ${phoneNumber}. The user must register first.`);
    process.exitCode = 1;
    return;
  }

  if (existing.role === roleArg) {
    console.log(`${phoneNumber} is already "${roleArg}" — nothing to do.`);
    return;
  }

  await prisma.user.update({ where: { phoneNumber }, data: { role: roleArg } });
  console.log(`${phoneNumber} (${existing.displayName}): ${existing.role} → ${roleArg}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
