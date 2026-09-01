import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { recordTombstone } from '../lib/tombstone';
import { assertCanAddVehicle } from '../lib/quota';

export const vehiclesRouter = Router();
vehiclesRouter.use(authenticate);

// Controlled value sets — mirror the Flutter app exactly.
const POWERTRAINS = ['petrol', 'diesel', 'electric', 'hybrid', 'plugin_hybrid'] as const;
const CATEGORIES = ['car', 'van', 'bike', 'truck', 'suv'] as const;

const currentYear = new Date().getFullYear();

// Base shape shared by create (all required) and update (all optional).
const baseFields = {
  type: z.enum(POWERTRAINS),
  vehicleType: z.enum(CATEGORIES),
  make: z.string().trim().min(1),
  model: z.string().trim().min(1),
  year: z.number().int().min(1900).max(currentYear + 1),
  licensePlate: z.string().trim().min(1).transform((s) => s.toUpperCase()),
  currentMileage: z.number().min(0),
  colour: z.string().trim().nullable().optional(),
  nickname: z.string().trim().nullable().optional(),
  nextServiceMileage: z.number().min(0).nullable().optional(),
  lastServiceMileage: z.number().min(0).nullable().optional(),
  serviceStation: z.string().trim().nullable().optional(),
  batteryVoltage: z.number().nullable().optional(),
  engineOilPercentage: z.number().nullable().optional(),
  gearOilStatus: z.string().trim().nullable().optional(),
  tirePressurePsi: z.number().nullable().optional(),
  lastFuelType: z.string().trim().nullable().optional(),
  lastPricePerLiter: z.number().nullable().optional(),
  batteryCapacityKwh: z.number().positive().nullable().optional(),
};

// EVs / plug-in hybrids must declare a battery capacity — same rule the app enforces.
const requiresBattery = (type: string | undefined, battery: number | null | undefined) =>
  !(type === 'electric' || type === 'plugin_hybrid') || (battery != null && battery > 0);

const createSchema = z
  .object(baseFields)
  .refine((v) => requiresBattery(v.type, v.batteryCapacityKwh), {
    message: 'batteryCapacityKwh is required for electric / plug-in hybrid vehicles',
    path: ['batteryCapacityKwh'],
  });

const updateSchema = z
  .object(baseFields)
  .partial()
  .strict()
  .refine((v) => v.type === undefined || requiresBattery(v.type, v.batteryCapacityKwh), {
    message: 'batteryCapacityKwh is required for electric / plug-in hybrid vehicles',
    path: ['batteryCapacityKwh'],
  });

const idParam = z.object({ id: z.string().uuid() });
const reorderSchema = z.object({ orderedIds: z.array(z.string().uuid()).min(1) });

const withTrackers = { trackers: { orderBy: { createdAt: 'asc' } } } as const;

// GET /vehicles — the user's garage, in their saved order, trackers embedded.
vehiclesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const vehicles = await prisma.vehicle.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: withTrackers,
    });
    res.json({ vehicles });
  }),
);

// PATCH /vehicles/reorder — persist a new garage ordering.
// Declared before "/:id" so "reorder" isn't captured as an id.
vehiclesRouter.patch(
  '/reorder',
  validate({ body: reorderSchema }),
  asyncHandler(async (req, res) => {
    const { orderedIds } = req.body as { orderedIds: string[] };

    const owned = await prisma.vehicle.findMany({
      where: { id: { in: orderedIds }, userId: req.user!.id },
      select: { id: true },
    });
    if (owned.length !== orderedIds.length) {
      throw ApiError.badRequest('orderedIds must reference vehicles you own');
    }

    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.vehicle.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    res.json({ ok: true });
  }),
);

// GET /vehicles/:id
vehiclesRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: withTrackers,
    });
    if (!vehicle) throw ApiError.notFound('Vehicle not found');
    res.json({ vehicle });
  }),
);

// POST /vehicles
vehiclesRouter.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    await assertCanAddVehicle(req.user!.id);
    const maxOrder = await prisma.vehicle.aggregate({
      where: { userId: req.user!.id },
      _max: { sortOrder: true },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        ...req.body,
        userId: req.user!.id,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      },
      include: withTrackers,
    });
    res.status(201).json({ vehicle });
  }),
);

// PUT /vehicles/:id — create or update a vehicle at a client-provided id
// (the app generates UUIDs locally, so this is the natural offline-sync verb).
vehiclesRouter.put(
  '/:id',
  validate({ params: idParam, body: createSchema }),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const existing = await prisma.vehicle.findUnique({
      where: { id },
      select: { userId: true, sortOrder: true },
    });
    if (existing && existing.userId !== req.user!.id) {
      throw ApiError.forbidden('You do not own this vehicle');
    }
    // Creating a brand-new vehicle (not updating one) counts against the quota.
    if (!existing) await assertCanAddVehicle(req.user!.id);
    // New rows go to the end of the garage; existing rows keep their position.
    let sortOrder = existing?.sortOrder;
    if (sortOrder === undefined) {
      const max = await prisma.vehicle.aggregate({
        where: { userId: req.user!.id },
        _max: { sortOrder: true },
      });
      sortOrder = (max._max.sortOrder ?? -1) + 1;
    }
    const vehicle = await prisma.vehicle.upsert({
      where: { id },
      create: { id, ...req.body, userId: req.user!.id, sortOrder },
      update: req.body,
      include: withTrackers,
    });
    res.json({ vehicle });
  }),
);

// PATCH /vehicles/:id
vehiclesRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => {
    // Ownership check via updateMany's where clause (won't touch others' rows).
    const result = await prisma.vehicle.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: req.body,
    });
    if (result.count === 0) throw ApiError.notFound('Vehicle not found');

    const vehicle = await prisma.vehicle.findUnique({
      where: { id: req.params.id },
      include: withTrackers,
    });
    res.json({ vehicle });
  }),
);

// DELETE /vehicles/:id — removes the vehicle and all its records (cascades).
// Emits a single tombstone; the client cascades the delete to local children.
vehiclesRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const count = await prisma.$transaction(async (tx) => {
      const del = await tx.vehicle.deleteMany({
        where: { id: req.params.id, userId: req.user!.id },
      });
      if (del.count > 0) await recordTombstone(tx, req.user!.id, 'vehicle', req.params.id);
      return del.count;
    });
    if (count === 0) throw ApiError.notFound('Vehicle not found');
    res.status(204).send();
  }),
);
