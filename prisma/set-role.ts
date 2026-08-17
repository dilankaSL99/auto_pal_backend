/**
 * Grant or revoke the admin tier.
 *
 *   npm run role:set -- someone@example.com admin
 *   npm run role:set -- someone@example.com user
 *   npm run role:set -- --list
 *
 * Roles are not settable over the API by design: promotion is an
 * infrastructure action, not something a signed-in session can perform.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [emailArg, roleArg] = process.argv.slice(2);

  if (emailArg === '--list') {
    const admins = await prisma.user.findMany({
      where: { role: 'admin' },
      select: { email: true, displayName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (admins.length === 0) {
      console.log('No admins yet. Grant one with:\n  npm run role:set -- you@example.com admin');
    } else {
      console.log(`${admins.length} admin(s):`);
      for (const a of admins) console.log(`  ${a.email}  (${a.displayName})`);
    }
    return;
  }

  if (!emailArg || (roleArg !== 'admin' && roleArg !== 'user')) {
    console.error('Usage: npm run role:set -- <email> <admin|user>');
    console.error('       npm run role:set -- --list');
    process.exitCode = 1;
    return;
  }

  const email = emailArg.toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, displayName: true },
  });

  if (!existing) {
    console.error(`No account found for ${email}. The user must register first.`);
    process.exitCode = 1;
    return;
  }

  if (existing.role === roleArg) {
    console.log(`${email} is already "${roleArg}" — nothing to do.`);
    return;
  }

  await prisma.user.update({ where: { email }, data: { role: roleArg } });
  console.log(`${email} (${existing.displayName}): ${existing.role} → ${roleArg}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
