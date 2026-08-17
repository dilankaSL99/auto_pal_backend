import { Router } from 'express';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import type { UserRole } from '@prisma/client';
import { prisma } from '../prisma';
import { googleClientIds } from '../env';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/password';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(1).max(80),
  phoneNumber: z.string().trim().max(40).optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// Shape the user object returned to clients (never leak the password hash).
// `role` is included so clients (e.g. the admin dashboard) can tell whether the
// account is an admin without probing an admin-only endpoint. This is a UX hint
// only — every /api/admin route still enforces the role server-side.
function publicUser(u: {
  id: string;
  email: string;
  displayName: string;
  phoneNumber: string | null;
  profileImageUrl: string | null;
  role: UserRole;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    phoneNumber: u.phoneNumber,
    profileImageUrl: u.profileImageUrl,
    role: u.role,
    createdAt: u.createdAt,
  };
}

function issueTokens(user: { id: string; email: string }) {
  return {
    accessToken: signAccessToken({ sub: user.id, email: user.email }),
    refreshToken: signRefreshToken(user.id),
  };
}

// POST /auth/register
authRouter.post(
  '/register',
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { email, password, displayName, phoneNumber } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw ApiError.conflict('An account with this email already exists');

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        displayName,
        phoneNumber: phoneNumber ?? null,
      },
    });

    res.status(201).json({ user: publicUser(user), ...issueTokens(user) });
  }),
);

// POST /auth/login
authRouter.post(
  '/login',
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    // Same message whether the email or password is wrong (no account enumeration).
    // `passwordHash` is null for Google-only accounts — treat as no match.
    if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    res.json({ user: publicUser(user), ...issueTokens(user) });
  }),
);

// POST /auth/google — verify a Google ID token and sign in / up.
const googleSchema = z.object({ idToken: z.string().min(1) });
const googleClient = new OAuth2Client();

authRouter.post(
  '/google',
  validate({ body: googleSchema }),
  asyncHandler(async (req, res) => {
    if (googleClientIds.length === 0) {
      throw new ApiError(503, 'Google sign-in is not configured', 'NOT_CONFIGURED');
    }
    const ticket = await googleClient
      .verifyIdToken({ idToken: req.body.idToken, audience: googleClientIds })
      .catch(() => null);
    const payload = ticket?.getPayload();
    if (!payload?.email || !payload.sub) {
      throw ApiError.unauthorized('Invalid Google token');
    }

    const email = payload.email.toLowerCase();
    const googleId = payload.sub;
    const displayName = payload.name?.trim() || email.split('@')[0];

    // Match by Google id first, then by email (links an existing password
    // account to Google on first Google sign-in).
    let user = await prisma.user.findFirst({ where: { OR: [{ googleId }, { email }] } });
    if (!user) {
      user = await prisma.user.create({ data: { email, googleId, displayName } });
    } else if (!user.googleId) {
      user = await prisma.user.update({ where: { id: user.id }, data: { googleId } });
    }

    res.json({ user: publicUser(user), ...issueTokens(user) });
  }),
);

// GET /auth/me — the currently authenticated account. Lets a client re-hydrate
// its session (and read `role`) after a page reload from a stored token alone.
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw ApiError.unauthorized('Account no longer exists');
    res.json({ user: publicUser(user) });
  }),
);

// POST /auth/refresh — exchange a valid refresh token for a new token pair.
authRouter.post(
  '/refresh',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const { sub } = verifyRefreshToken(req.body.refreshToken);
    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user) throw ApiError.unauthorized('Account no longer exists');

    res.json(issueTokens(user));
  }),
);
