import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../prisma';
import { ApiError } from '../lib/errors';

// Gates Pro-only endpoints. Must run *after* `authenticate`. The tier is read
// from the DB on every request (not the token) so a downgrade takes effect
// immediately. Returns the same 402 UPGRADE_REQUIRED the app turns into a
// paywall at the tier-limit boundaries.
export async function requirePro(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized('Missing Bearer token');
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { tier: true },
    });
    if (!user || user.tier !== 'pro') {
      throw new ApiError(402, 'This feature requires Auto Pal Pro.', 'UPGRADE_REQUIRED');
    }
    next();
  } catch (err) {
    next(err);
  }
}
