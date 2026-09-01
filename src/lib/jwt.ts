import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../env';
import { ApiError } from './errors';

export interface AccessTokenPayload {
  sub: string; // user id
  phoneNumber: string;
}

interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  tokenVersion: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  } as SignOptions);
}

export function signRefreshToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, type: 'refresh', tokenVersion }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof decoded === 'string') throw new Error('bad token');
    return { sub: String(decoded.sub), phoneNumber: String(decoded.phoneNumber) };
  } catch {
    throw ApiError.unauthorized('Invalid or expired access token');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
    if (typeof decoded === 'string' || decoded.type !== 'refresh') {
      throw new Error('bad token');
    }
    return {
      sub: String(decoded.sub),
      type: 'refresh',
      // Older tokens issued before token versioning default to 0, matching a
      // freshly-migrated user's tokenVersion so existing sessions keep working.
      tokenVersion: typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0,
    };
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
}
