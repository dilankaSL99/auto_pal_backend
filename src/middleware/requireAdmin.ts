import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../prisma';
import { ApiError } from '../lib/errors';

// Gates the cross-account /api/admin routes. Must run *after* `authenticate`.
//
// The role is read from the database on every request rather than carried in
// the access token. Access tokens live for 15 minutes and are not revocable,
// so a role baked into the JWT would keep working for up to 15 minutes after
// an admin was demoted. One indexed primary-key lookup is a cheap price for
// revocation taking effect immediately.
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized('Missing Bearer token');

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { role: true },
    });

    // Same 403 whether the account is gone or simply not an admin — a
    // non-admin should not be able to probe which accounts exist.
    if (!user || user.role !== 'admin') {
      throw ApiError.forbidden('Administrator access required');
    }

    next();
  } catch (err) {
    next(err);
  }
}
