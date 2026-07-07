import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';

export const preferencesRouter = Router();
preferencesRouter.use(authenticate);

const patchSchema = z
  .object({
    distanceUnit: z.enum(['km', 'mi']).optional(),
    fuelVolumeUnit: z.enum(['liter', 'gallon']).optional(),
    currency: z.string().trim().min(1).max(8).optional(),
    autoBackupEnabled: z.boolean().optional(),
    backupFrequency: z.enum(['daily', 'weekly', 'monthly', 'off']).optional(),
    lastBackupAt: z.coerce.date().nullable().optional(),
  })
  .strict();

// Returns the user's preferences, creating a default row on first read.
async function getOrCreate(userId: string) {
  return prisma.userPreferences.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

// GET /preferences
preferencesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ preferences: await getOrCreate(req.user!.id) });
  }),
);

// PATCH /preferences
preferencesRouter.patch(
  '/',
  validate({ body: patchSchema }),
  asyncHandler(async (req, res) => {
    const preferences = await prisma.userPreferences.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...req.body },
      update: req.body,
    });
    res.json({ preferences });
  }),
);
