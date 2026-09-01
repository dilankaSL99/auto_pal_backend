import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { recordTombstone } from '../lib/tombstone';
import { upload, saveUpload, deleteUpload, streamUpload } from '../lib/upload';
import { assertCanAddDocument } from '../lib/quota';

export const documentsRouter = Router();
documentsRouter.use(authenticate);

const DOC_TYPES = [
  'driversLicense',
  'revenueLicense',
  'insurance',
  'registration',
  'emissionTest',
  'other',
] as const;

const idParam = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  documentType: z.enum(DOC_TYPES),
  expiryDate: z.coerce.date().nullable().optional(),
});

const updateSchema = createSchema.partial().strict();

// GET /documents
documentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const documents = await prisma.document.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ documents });
  }),
);

// GET /documents/:id
documentsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!document) throw ApiError.notFound('Document not found');
    res.json({ document });
  }),
);

// POST /documents — create metadata (upload the file separately via /:id/file).
documentsRouter.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    await assertCanAddDocument(req.user!.id);
    const document = await prisma.document.create({
      data: { ...req.body, userId: req.user!.id },
    });
    res.status(201).json({ document });
  }),
);

// PATCH /documents/:id
documentsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => {
    const result = await prisma.document.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: req.body,
    });
    if (result.count === 0) throw ApiError.notFound('Document not found');
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    res.json({ document });
  }),
);

// DELETE /documents/:id
documentsRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true, filePath: true },
    });
    if (!document) throw ApiError.notFound('Document not found');
    await prisma.$transaction(async (tx) => {
      await tx.document.delete({ where: { id: document.id } });
      await recordTombstone(tx, req.user!.id, 'document', document.id);
    });
    await deleteUpload(document.filePath);
    res.status(204).send();
  }),
);

// POST /documents/:id/file — upload/replace the file (field: "file").
documentsRouter.post(
  '/:id/file',
  validate({ params: idParam }),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Expected a file in field "file"');
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    });
    if (!document) throw ApiError.notFound('Document not found');

    const stored = await saveUpload(req.user!.id, 'documents', document.id, req.file);
    const updated = await prisma.document.update({
      where: { id: document.id },
      data: {
        filePath: stored.relativePath,
        fileName: stored.fileName,
        fileUrl: `/api/documents/${document.id}/file`,
      },
    });
    res.status(201).json({ document: updated });
  }),
);

// GET /documents/:id/file — stream the file.
documentsRouter.get(
  '/:id/file',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { filePath: true, fileName: true },
    });
    if (!document?.filePath || !streamUpload(res, document.filePath, document.fileName)) {
      throw ApiError.notFound('No file for this document');
    }
  }),
);
