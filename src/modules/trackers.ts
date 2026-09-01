import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { assertVehicleOwned } from '../lib/ownership';
import { recordTombstone } from '../lib/tombstone';
import { assertCanAddTracker } from '../lib/quota';

// mergeParams lets this nested router read :vehicleId from the parent mount.
export const trackersRouter = Router({ mergeParams: true });
trackersRouter.use(authenticate);

const vehicleParam = z.object({ vehicleId: z.string().uuid() });
const bothParams = z.object({ vehicleId: z.string().uuid(), id: z.string().uuid() });

const fullSchema = z.object({
  name: z.string().trim().min(1).max(120),
  lastServiceDate: z.coerce.date().nullable().optional(),
  lastServiceMileage: z.number().min(0).nullable().optional(),
  nextServiceDate: z.coerce.date().nullable().optional(),
  nextServiceMileage: z.number().min(0).nullable().optional(),
});

const updateSchema = fullSchema.partial().strict();

// GET /vehicles/:vehicleId/trackers
trackersRouter.get(
  '/',
  validate({ params: vehicleParam }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.params.vehicleId);
    const trackers = await prisma.trackerItem.findMany({
      where: { vehicleId: req.params.vehicleId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ trackers });
  }),
);

// GET /vehicles/:vehicleId/trackers/:id
trackersRouter.get(
  '/:id',
  validate({ params: bothParams }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.params.vehicleId);
    const tracker = await prisma.trackerItem.findFirst({
      where: { id: req.params.id, vehicleId: req.params.vehicleId },
    });
    if (!tracker) throw ApiError.notFound('Tracker not found');
    res.json({ tracker });
  }),
);

// POST /vehicles/:vehicleId/trackers — create with a server-generated id.
trackersRouter.post(
  '/',
  validate({ params: vehicleParam, body: fullSchema }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.params.vehicleId);
    await assertCanAddTracker(req.user!.id, req.params.vehicleId);
    await assertUniqueName(req.params.vehicleId, req.body.name);
    const tracker = await prisma.trackerItem.create({
      data: { ...req.body, vehicleId: req.params.vehicleId },
    });
    res.status(201).json({ tracker });
  }),
);

// PUT /vehicles/:vehicleId/trackers/:id — create or update at a given id.
trackersRouter.put(
  '/:id',
  validate({ params: bothParams, body: fullSchema }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.params.vehicleId);
    const existing = await prisma.trackerItem.findUnique({
      where: { id: req.params.id },
      select: { vehicleId: true },
    });
    if (existing && existing.vehicleId !== req.params.vehicleId) {
      throw ApiError.forbidden('Tracker belongs to a different vehicle');
    }
    // Creating a new tracker (not updating one) counts against the per-vehicle quota.
    if (!existing) await assertCanAddTracker(req.user!.id, req.params.vehicleId);
    await assertUniqueName(req.params.vehicleId, req.body.name, req.params.id);
    const tracker = await prisma.trackerItem.upsert({
      where: { id: req.params.id },
      create: { id: req.params.id, ...req.body, vehicleId: req.params.vehicleId },
      update: req.body,
    });
    res.json({ tracker });
  }),
);

// PATCH /vehicles/:vehicleId/trackers/:id
trackersRouter.patch(
  '/:id',
  validate({ params: bothParams, body: updateSchema }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.params.vehicleId);
    if (req.body.name) await assertUniqueName(req.params.vehicleId, req.body.name, req.params.id);
    const result = await prisma.trackerItem.updateMany({
      where: { id: req.params.id, vehicleId: req.params.vehicleId },
      data: req.body,
    });
    if (result.count === 0) throw ApiError.notFound('Tracker not found');
    const tracker = await prisma.trackerItem.findUnique({ where: { id: req.params.id } });
    res.json({ tracker });
  }),
);

// DELETE /vehicles/:vehicleId/trackers/:id
trackersRouter.delete(
  '/:id',
  validate({ params: bothParams }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.params.vehicleId);
    const count = await prisma.$transaction(async (tx) => {
      const del = await tx.trackerItem.deleteMany({
        where: { id: req.params.id, vehicleId: req.params.vehicleId },
      });
      if (del.count > 0) await recordTombstone(tx, req.user!.id, 'tracker', req.params.id);
      return del.count;
    });
    if (count === 0) throw ApiError.notFound('Tracker not found');
    res.status(204).send();
  }),
);

// Tracker names are unique per vehicle (matches the app's duplicate check).
async function assertUniqueName(vehicleId: string, name: string, ignoreId?: string) {
  const dupe = await prisma.trackerItem.findFirst({
    where: {
      vehicleId,
      name: { equals: name, mode: 'insensitive' },
      ...(ignoreId ? { id: { not: ignoreId } } : {}),
    },
    select: { id: true },
  });
  if (dupe) throw ApiError.conflict('A tracker with this name already exists');
}
