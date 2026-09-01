import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/prisma';

// A single app instance for the suite. NODE_ENV=test (set by vitest) disables
// the global + auth rate limiters, so integration tests aren't throttled; the
// limiter itself is covered by a dedicated unit test.
export const app = createApp();

// Unique phone number per call — tests share the dev DB, so identifiers must not
// collide across parallel test files.
export function uniquePhone(): string {
  const n = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return `+19${n}`.slice(0, 40);
}

export interface TestUser {
  phoneNumber: string;
  password: string;
  displayName: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown>;
}

export async function registerUser(
  overrides: Partial<Pick<TestUser, 'phoneNumber' | 'password' | 'displayName'>> = {},
): Promise<TestUser> {
  const phoneNumber = overrides.phoneNumber ?? uniquePhone();
  const password = overrides.password ?? 'password123';
  const displayName = overrides.displayName ?? 'Test User';
  const res = await request(app)
    .post('/api/auth/register')
    .send({ phoneNumber, password, displayName });
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    phoneNumber,
    password,
    displayName,
    userId: res.body.user.id,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    user: res.body.user,
  };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Remove a user (cascades to their vehicles/records) so the shared DB stays clean.
export async function cleanupUsers(...phoneNumbers: string[]) {
  await prisma.user.deleteMany({ where: { phoneNumber: { in: phoneNumbers } } });
}
