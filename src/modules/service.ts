import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { assertVehicleOwned } from '../lib/ownership';
import { recordTombstone } from '../lib/tombstone';
import { upload, saveUpload, deleteUpload, streamUpload } from '../lib/upload';

export const serviceRouter = Router();
serviceRouter.use(authenticate);

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ vehicleId: z.string().uuid() });

const putSchema = z.object({
  vehicleId: z.string().uuid(),
  dateOfService: z.coerce.date(),
  serviceType: z.string().trim().min(1),
  mileageAtService: z.number().min(0),
  cost: z.number().min(0).nullable().optional(),
  serviceStation: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  nextServiceMileage: z.number().min(0).nullable().optional(),
});

// GET /service-records?vehicleId=...  (newest first)
serviceRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const vehicleId = req.query.vehicleId as string;
    await assertVehicleOwned(req.user!.id, vehicleId);
    const records = await prisma.serviceRecord.findMany({
      where: { vehicleId, userId: req.user!.id },
      orderBy: { dateOfService: 'desc' },
    });
    res.json({ records });
  }),
);

// GET /service-records/:id
serviceRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const record = await prisma.serviceRecord.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!record) throw ApiError.notFound('Service record not found');
    res.json({ record });
  }),
);

// PUT /service-records/:id — create or update at a client-provided id.
serviceRouter.put(
  '/:id',
  validate({ params: idParam, body: putSchema }),
  asyncHandler(async (req, res) => {
    await assertVehicleOwned(req.user!.id, req.body.vehicleId);
    const existing = await prisma.serviceRecord.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (existing && existing.userId !== req.user!.id) {
      throw ApiError.forbidden('You do not own this record');
    }
    const record = await prisma.serviceRecord.upsert({
      where: { id: req.params.id },
      create: { id: req.params.id, userId: req.user!.id, ...req.body },
      update: req.body,
    });
    res.json({ record });
  }),
);

// DELETE /service-records/:id
serviceRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const record = await prisma.serviceRecord.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true, attachmentPath: true },
    });
    if (!record) throw ApiError.notFound('Service record not found');
    await prisma.$transaction(async (tx) => {
      await tx.serviceRecord.delete({ where: { id: record.id } });
      await recordTombstone(tx, req.user!.id, 'serviceRecord', record.id);
    });
    await deleteUpload(record.attachmentPath);
    res.status(204).send();
  }),
);

// POST /service-records/:id/attachment — upload/replace a receipt (field: "attachment").
serviceRouter.post(
  '/:id/attachment',
  validate({ params: idParam }),
  upload.single('attachment'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Expected a file in field "attachment"');
    const record = await prisma.serviceRecord.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    });
    if (!record) throw ApiError.notFound('Service record not found');

    const stored = await saveUpload(req.user!.id, 'service', record.id, req.file);
    const updated = await prisma.serviceRecord.update({
      where: { id: record.id },
      data: {
        attachmentPath: stored.relativePath,
        attachmentFileName: stored.fileName,
        attachmentUrl: `/api/service-records/${record.id}/attachment`,
      },
    });
    res.status(201).json({ record: updated });
  }),
);

// GET /service-records/:id/attachment — stream the receipt.
serviceRouter.get(
  '/:id/attachment',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const record = await prisma.serviceRecord.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { attachmentPath: true, attachmentFileName: true },
    });
    if (!record?.attachmentPath || !streamUpload(res, record.attachmentPath, record.attachmentFileName)) {
      throw ApiError.notFound('No attachment');
    }
  }),
);
