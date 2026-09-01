/**
 * Set an account's subscription tier by hand (dev / support).
 *
 *   npm run tier:set -- +15551234567 pro
 *   npm run tier:set -- +15551234567 free
 *   npm run tier:set -- --list
 *
 * In production the tier is normally flipped by the subscription webhook; this
 * script is for testing and manual overrides.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [phoneArg, tierArg] = process.argv.slice(2);

  if (phoneArg === '--list') {
    const pros = await prisma.user.findMany({
      where: { tier: 'pro' },
      select: { phoneNumber: true, displayName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (pros.length === 0) {
      console.log('No Pro accounts yet. Grant one with:\n  npm run tier:set -- +15551234567 pro');
    } else {
      console.log(`${pros.length} Pro account(s):`);
      for (const p of pros) console.log(`  ${p.phoneNumber}  (${p.displayName})`);
    }
    return;
  }

  if (!phoneArg || (tierArg !== 'pro' && tierArg !== 'free')) {
    console.error('Usage: npm run tier:set -- <phoneNumber> <pro|free>');
    console.error('       npm run tier:set -- --list');
    process.exitCode = 1;
    return;
  }

  const phoneNumber = phoneArg.trim();
  const existing = await prisma.user.findUnique({
    where: { phoneNumber },
    select: { id: true, tier: true, displayName: true },
  });

  if (!existing) {
    console.error(`No account found for ${phoneNumber}. The user must register first.`);
    process.exitCode = 1;
    return;
  }

  if (existing.tier === tierArg) {
    console.log(`${phoneNumber} is already "${tierArg}" — nothing to do.`);
    return;
  }

  await prisma.user.update({ where: { phoneNumber }, data: { tier: tierArg } });
  console.log(`${phoneNumber} (${existing.displayName}): ${existing.tier} → ${tierArg}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
