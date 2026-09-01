import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { UserRole, UserTier } from '@prisma/client';
import { limitsForTier } from '../lib/entitlements';
import { prisma } from '../prisma';
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
import { rateLimit } from '../middleware/rateLimit';
import { env } from '../env';

export const authRouter = Router();

// Strict limiter for credential-handling endpoints (login / register / refresh)
// to blunt brute-force and credential-stuffing attacks. Keyed per IP. Disabled
// under test so the suite can hammer these freely.
const authLimiter: RequestHandler =
  env.NODE_ENV === 'test'
    ? (_req, _res, next) => next()
    : rateLimit({
        windowMs: 15 * 60_000,
        max: 20,
        message: 'Too many attempts. Please wait a few minutes and try again.',
      });

// Phone number is the primary login credential. Kept permissive on format so
// international numbers pass through unchanged; uniqueness is enforced by the DB.
const phoneNumber = z.string().trim().min(5, 'Enter a valid phone number').max(40);

const registerSchema = z.object({
  phoneNumber,
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(1).max(80),
});

const loginSchema = z.object({
  phoneNumber,
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
  phoneNumber: string;
  displayName: string;
  profileImageUrl: string | null;
  role: UserRole;
  tier: UserTier;
  createdAt: Date;
}) {
  return {
    id: u.id,
    phoneNumber: u.phoneNumber,
    displayName: u.displayName,
    profileImageUrl: u.profileImageUrl,
    role: u.role,
    // Subscription tier — a UX hint for the client. Every limit is still
    // enforced server-side on write, regardless of what the client believes.
    tier: u.tier,
    createdAt: u.createdAt,
  };
}

function issueTokens(user: { id: string; phoneNumber: string; tokenVersion: number }) {
  return {
    accessToken: signAccessToken({ sub: user.id, phoneNumber: user.phoneNumber }),
    refreshToken: signRefreshToken(user.id, user.tokenVersion),
  };
}

// POST /auth/register
authRouter.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { phoneNumber, password, displayName } = req.body;

    const existing = await prisma.user.findUnique({ where: { phoneNumber } });
    if (existing) throw ApiError.conflict('An account with this phone number already exists');

    const user = await prisma.user.create({
      data: {
        phoneNumber,
        passwordHash: await hashPassword(password),
        displayName,
      },
    });

    res.status(201).json({ user: publicUser(user), ...issueTokens(user) });
  }),
);

// POST /auth/login
authRouter.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { phoneNumber, password } = req.body;

    const user = await prisma.user.findUnique({ where: { phoneNumber } });
    // Same message whether the phone number or password is wrong (no account
    // enumeration). `passwordHash` is null for accounts with no local password.
    if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw ApiError.unauthorized('Invalid phone number or password');
    }

    res.json({ user: publicUser(user), ...issueTokens(user) });
  }),
);

// Builds the entitlements block the client uses to render paywalls / upgrade
// CTAs and gate the next add. `limits` is the tier's caps; `usage` is the live
// count so the app can show "1 of 1 vehicles used".
async function computeEntitlements(userId: string, tier: UserTier) {
  const [vehicles, reminders, documents] = await Promise.all([
    prisma.vehicle.count({ where: { userId } }),
    prisma.reminder.count({ where: { userId } }),
    prisma.document.count({ where: { userId } }),
  ]);
  return { tier, limits: limitsForTier(tier), usage: { vehicles, reminders, documents } };
}

// GET /auth/me — the currently authenticated account. Lets a client re-hydrate
// its session (and read `role` / `tier`) from a stored token alone.
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw ApiError.unauthorized('Account no longer exists');
    res.json({
      user: publicUser(user),
      entitlements: await computeEntitlements(user.id, user.tier),
    });
  }),
);

// GET /auth/entitlements — the tier, its limits, and current usage. A focused
// endpoint the mobile app polls to keep its paywall gating in sync.
authRouter.get(
  '/entitlements',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, tier: true },
    });
    if (!user) throw ApiError.unauthorized('Account no longer exists');
    res.json({ entitlements: await computeEntitlements(user.id, user.tier) });
  }),
);

// POST /auth/refresh — exchange a valid refresh token for a new token pair.
authRouter.post(
  '/refresh',
  authLimiter,
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const { sub, tokenVersion } = verifyRefreshToken(req.body.refreshToken);
    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user) throw ApiError.unauthorized('Account no longer exists');
    // Revocation check: a bumped tokenVersion (logout / password change)
    // invalidates every refresh token issued before the bump.
    if (user.tokenVersion !== tokenVersion) {
      throw ApiError.unauthorized('This session has been signed out');
    }

    res.json(issueTokens(user));
  }),
);

// POST /auth/logout — server-side sign-out. Bumps the token version so all
// outstanding refresh tokens for this account stop working immediately. Access
// tokens (15 min) are stateless and expire on their own.
authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { tokenVersion: { increment: 1 } },
    });
    res.json({ ok: true });
  }),
);
