import { PrismaClient } from '@prisma/client';
import { env } from './env';

// Single shared PrismaClient. In dev, `tsx watch` reloads the module on every
// change; caching on globalThis prevents exhausting the DB connection pool
// with a new client per reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
