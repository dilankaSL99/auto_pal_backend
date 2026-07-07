import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { assertVehicleOwned } from '../lib/ownership';
import { recordTombstone } from '../lib/tombstone';

export const remindersRouter = Router();
remindersRouter.use(authenticate);

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ vehicleId: z.string().uuid() });

const putSchema = z.object({
  vehicleId: z.string().uuid(),
  serviceType: z.string().trim().min(1),
  triggerType: z.enum(['days', 'mileage']),
  triggerValue: z.number().positive(),
  notes: z.string().trim().nullable().optional(),
  preferredServiceProvider: z.string().trim().nullable().optional(),
  isDone: z.boolean().optional().default(false),
});

const patchSchema = putSchema.partial().omit({ vehicleId: true }).strict();

// GET /reminders?vehicleId=...
remindersRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const vehicleId = req.query.vehicleId as string;
    await assertVehicleOwned(req.user!.id, vehicleId);
    const reminders = await prisma.reminder.findMany({
      where: { vehicleId, userId: req.user!.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ reminders });
  }),
);

// GET /reminders/:id
remindersRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const reminder = await prisma.reminder.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!reminder) throw ApiError.notFound('Reminder not found');
    res.json({ reminder });
  }),
);

// PUT /reminders/:id — create or update at a client-provided id.
remindersRouter.put(
  '/:id',
  validate({ params: idParam, body: putSchema }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.body.vehicleId);
    const existing = await prisma.reminder.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (existing && existing.userId !== req.user!.id) {
      throw ApiError.forbidden('You do not own this reminder');
    }
    const reminder = await prisma.reminder.upsert({
      where: { id: req.params.id },
      create: { id: req.params.id, userId: req.user!.id, ...req.body },
      update: req.body,
    });
    res.json({ reminder });
  }),
);

// PATCH /reminders/:id
remindersRouter.patch(
  '/:id',
  validate({ params: idParam, body: patchSchema }),
  asyncHandler(async (req, res) => {
    const result = await prisma.reminder.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: req.body,
    });
    if (result.count === 0) throw ApiError.notFound('Reminder not found');
    const reminder = await prisma.reminder.findUnique({ where: { id: req.params.id } });
    res.json({ reminder });
  }),
);

// DELETE /reminders/:id
remindersRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const count = await prisma.$transaction(async (tx) => {
      const del = await tx.reminder.deleteMany({
        where: { id: req.params.id, userId: req.user!.id },
      });
      if (del.count > 0) await recordTombstone(tx, req.user!.id, 'reminder', req.params.id);
      return del.count;
    });
    if (count === 0) throw ApiError.notFound('Reminder not found');
    res.status(204).send();
  }),
);
