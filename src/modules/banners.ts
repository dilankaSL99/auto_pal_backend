import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';
import { upload, saveUpload, deleteUpload, streamUpload } from '../lib/upload';

const idParam = z.object({ id: z.string().uuid() });

// ── Public / app-user facing router (mounted at /api/banners) ───────────────
export const bannersRouter = Router();

// GET /banners/active — the active banners the mobile dashboard rotates through.
// Requires a logged-in app user; the image bytes themselves are served publicly
// below so Image.network can render them without auth headers.
bannersRouter.get(
  '/active',
  authenticate,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.promoBanner.findMany({
      where: { active: true, imagePath: { not: null } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, title: true, linkUrl: true },
    });
    const banners = rows.map((b) => ({
      ...b,
      imageUrl: `/api/banners/${b.id}/image`,
    }));
    res.json({ banners });
  }),
);

// GET /banners/:id/image — stream the banner image. Public (no auth): banners
// are broadcast promo content, and a public URL lets both the app and the
// dashboard render it as a plain image source.
bannersRouter.get(
  '/:id/image',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const banner = await prisma.promoBanner.findUnique({
      where: { id: req.params.id },
      select: { imagePath: true, imageName: true },
    });
    if (!banner?.imagePath || !streamUpload(res, banner.imagePath, banner.imageName)) {
      throw ApiError.notFound('No image for this banner');
    }
  }),
);

// ── Admin management router (mounted at /api/admin/banners) ──────────────────
export const adminBannersRouter = Router();
adminBannersRouter.use(authenticate, requireAdmin);

const createSchema = z.object({
  title: z.string().trim().max(160).optional(),
  linkUrl: z.string().trim().url().max(2048).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const updateSchema = createSchema.partial().strict();

// GET /admin/banners — every banner, active or not, newest first.
adminBannersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const banners = await prisma.promoBanner.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ banners });
  }),
);

// POST /admin/banners — create metadata (upload the image separately via
// /:id/image, mirroring the documents flow).
adminBannersRouter.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const banner = await prisma.promoBanner.create({ data: req.body });
    res.status(201).json({ banner });
  }),
);

// PATCH /admin/banners/:id
adminBannersRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(async (req, res) => {
    try {
      const banner = await prisma.promoBanner.update({
        where: { id: req.params.id },
        data: req.body,
      });
      res.json({ banner });
    } catch {
      throw ApiError.notFound('Banner not found');
    }
  }),
);

// DELETE /admin/banners/:id
adminBannersRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const banner = await prisma.promoBanner.findUnique({
      where: { id: req.params.id },
      select: { id: true, imagePath: true },
    });
    if (!banner) throw ApiError.notFound('Banner not found');
    await prisma.promoBanner.delete({ where: { id: banner.id } });
    await deleteUpload(banner.imagePath);
    res.status(204).send();
  }),
);

// POST /admin/banners/:id/image — upload/replace the image (field: "file").
adminBannersRouter.post(
  '/:id/image',
  validate({ params: idParam }),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Expected a file in field "file"');
    const banner = await prisma.promoBanner.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!banner) throw ApiError.notFound('Banner not found');

    // Bucketed under the acting admin's id, matching saveUpload's layout.
    const stored = await saveUpload(req.user!.id, 'banners', banner.id, req.file);
    const updated = await prisma.promoBanner.update({
      where: { id: banner.id },
      data: { imagePath: stored.relativePath, imageName: stored.fileName },
    });
    res.status(201).json({ banner: updated });
  }),
);
