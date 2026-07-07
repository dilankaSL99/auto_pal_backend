import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { recordTombstone } from '../lib/tombstone';

// The driving licence — exactly one per user, so this is a singleton resource
// (GET / PUT / DELETE), not a collection.
export const licenseRouter = Router();
licenseRouter.use(authenticate);

const upsertSchema = z.object({
  fullName: z.string().trim().min(1),
  licenseNumber: z.string().trim().min(1),
  dateOfBirth: z.coerce.date().nullable().optional(),
  licenceClass: z.string().trim().optional().default(''),
  address: z.string().trim().optional().default(''),
  issuedDate: z.coerce.date().nullable().optional(),
  expiryDate: z.coerce.date().nullable().optional(),
});

// GET /license — returns the licence or null if none saved yet.
licenseRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const license = await prisma.driverLicense.findUnique({
      where: { userId: req.user!.id },
    });
    res.json({ license });
  }),
);

// PUT /license — create or replace the licence.
licenseRouter.put(
  '/',
  validate({ body: upsertSchema }),
  asyncHandler(async (req, res) => {
    const data = req.body;
    const license = await prisma.driverLicense.upsert({
      where: { userId: req.user!.id },
      create: { ...data, userId: req.user!.id },
      update: data,
    });
    res.json({ license });
  }),
);

// DELETE /license
licenseRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const existing = await prisma.driverLicense.findUnique({
      where: { userId: req.user!.id },
      select: { id: true },
    });
    if (!existing) return res.status(204).send();
    await prisma.$transaction(async (tx) => {
      await tx.driverLicense.delete({ where: { userId: req.user!.id } });
      await recordTombstone(tx, req.user!.id, 'driverLicense', existing.id);
    });
    res.status(204).send();
  }),
);
