import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { assertVehicleOwned } from '../lib/ownership';
import { recordTombstone } from '../lib/tombstone';

export const fuelRouter = Router();
fuelRouter.use(authenticate);

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ vehicleId: z.string().uuid() });

const putSchema = z.object({
  vehicleId: z.string().uuid(),
  date: z.coerce.date(),
  liters: z.number().positive(),
  fuelType: z.string().trim().min(1),
  odometer: z.number().min(0),
  pricePerLiter: z.number().min(0),
  stationName: z.string().trim().nullable().optional(),
  isFullTank: z.boolean().optional().default(false),
});

// GET /fuel-records?vehicleId=...  (newest first)
fuelRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const vehicleId = req.query.vehicleId as string;
    await assertVehicleOwned(req.user!.id, vehicleId);
    const records = await prisma.fuelRecord.findMany({
      where: { vehicleId, userId: req.user!.id },
      orderBy: { date: 'desc' },
    });
    res.json({ records });
  }),
);

// GET /fuel-records/:id
fuelRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const record = await prisma.fuelRecord.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!record) throw ApiError.notFound('Fuel record not found');
    res.json({ record });
  }),
);

// PUT /fuel-records/:id — create or update at a client-provided id.
fuelRouter.put(
  '/:id',
  validate({ params: idParam, body: putSchema }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.body.vehicleId);
    const existing = await prisma.fuelRecord.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (existing && existing.userId !== req.user!.id) {
      throw ApiError.forbidden('You do not own this record');
    }
    const record = await prisma.fuelRecord.upsert({
      where: { id: req.params.id },
      create: { id: req.params.id, userId: req.user!.id, ...req.body },
      update: req.body,
    });
    res.json({ record });
  }),
);

// DELETE /fuel-records/:id
fuelRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const count = await prisma.$transaction(async (tx) => {
      const del = await tx.fuelRecord.deleteMany({
        where: { id: req.params.id, userId: req.user!.id },
      });
      if (del.count > 0) await recordTombstone(tx, req.user!.id, 'fuelRecord', req.params.id);
      return del.count;
    });
    if (count === 0) throw ApiError.notFound('Fuel record not found');
    res.status(204).send();
  }),
);
