import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';

// Requires a valid Bearer access token. Populates `req.user` on success.
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing Bearer token');
  }
  const token = header.slice('Bearer '.length).trim();
  const payload = verifyAccessToken(token);
  req.user = { id: payload.sub, phoneNumber: payload.phoneNumber };
  next();
}
