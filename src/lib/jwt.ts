import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../env';
import { ApiError } from './errors';

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
}

interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  } as SignOptions);
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, type: 'refresh' }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof decoded === 'string') throw new Error('bad token');
    return { sub: String(decoded.sub), email: String(decoded.email) };
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
    return { sub: String(decoded.sub), type: 'refresh' };
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
}
