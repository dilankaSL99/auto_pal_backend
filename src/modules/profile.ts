import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { hashPassword, verifyPassword } from '../lib/password';
import { upload, saveUpload, deleteUpload, streamUpload } from '../lib/upload';

export const profileRouter = Router();
profileRouter.use(authenticate);

const select = {
  id: true,
  email: true,
  displayName: true,
  phoneNumber: true,
  profileImageUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    phoneNumber: z.string().trim().max(40).nullable().optional(),
  })
  .strict();

// GET /profile — read profile.
profileRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select });
    if (!user) throw ApiError.notFound('User not found');
    res.json({ profile: user });
  }),
);

// PUT /profile — update details.
profileRouter.put(
  '/',
  validate({ body: updateSchema }),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: req.body,
      select,
    });
    res.json({ profile: user });
  }),
);

// DELETE /profile — delete the account and everything it owns (cascades).
profileRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    await prisma.user.delete({ where: { id: req.user!.id } });
    res.status(204).send();
  }),
);

// PATCH /profile/password — change the account password.
const passwordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

profileRouter.patch(
  '/password',
  validate({ body: passwordSchema }),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { passwordHash: true },
    });
    if (!user) throw ApiError.notFound('User not found');

    // Accounts that already have a password must prove the current one. Google
    // -only accounts (no passwordHash) can set one without a current password.
    if (user.passwordHash) {
      const ok =
        !!req.body.currentPassword &&
        (await verifyPassword(req.body.currentPassword, user.passwordHash));
      if (!ok) throw ApiError.unauthorized('Current password is incorrect');
    }

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { passwordHash: await hashPassword(req.body.newPassword) },
    });
    res.json({ ok: true });
  }),
);

// POST /profile/photo — upload/replace the avatar (multipart field: "photo").
profileRouter.post(
  '/photo',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Expected a file in field "photo"');
    const stored = await saveUpload(req.user!.id, 'profile', req.user!.id, req.file);
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { profileImagePath: stored.relativePath, profileImageUrl: '/api/profile/photo' },
      select,
    });
    res.status(201).json({ profile: user });
  }),
);

// GET /profile/photo — stream the avatar.
profileRouter.get(
  '/photo',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { profileImagePath: true },
    });
    if (!user?.profileImagePath || !streamUpload(res, user.profileImagePath)) {
      throw ApiError.notFound('No profile photo');
    }
  }),
);

// DELETE /profile/photo — remove the avatar.
profileRouter.delete(
  '/photo',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { profileImagePath: true },
    });
    await deleteUpload(user?.profileImagePath);
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { profileImagePath: null, profileImageUrl: null },
    });
    res.status(204).send();
  }),
);
