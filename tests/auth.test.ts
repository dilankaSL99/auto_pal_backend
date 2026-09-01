import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, auth, cleanupUsers, uniquePhone } from './helpers';
import { prisma } from '../src/prisma';

const created: string[] = [];
afterAll(async () => {
  await cleanupUsers(...created);
  await prisma.$disconnect();
});

describe('auth', () => {
  it('registers a user and never leaks the password hash', async () => {
    const phoneNumber = uniquePhone();
    created.push(phoneNumber);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ phoneNumber, password: 'password123', displayName: 'Alice' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.phoneNumber).toBe(phoneNumber);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('$2'); // no bcrypt hash anywhere
  });

  it('rejects a short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ phoneNumber: uniquePhone(), password: 'short', displayName: 'x' });
    expect(res.status).toBe(400);
  });

  it('uses a generic message for both wrong-password and unknown-account (no enumeration)', async () => {
    const u = await registerUser();
    created.push(u.phoneNumber);

    const wrongPw = await request(app)
      .post('/api/auth/login')
      .send({ phoneNumber: u.phoneNumber, password: 'wrongpassword' });
    const noAccount = await request(app)
      .post('/api/auth/login')
      .send({ phoneNumber: uniquePhone(), password: 'whatever123' });

    expect(wrongPw.status).toBe(401);
    expect(noAccount.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(noAccount.body.error.message);
  });

  it('logs in with correct credentials', async () => {
    const u = await registerUser();
    created.push(u.phoneNumber);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ phoneNumber: u.phoneNumber, password: u.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('protects /auth/me and requires a valid bearer token', async () => {
    const u = await registerUser();
    created.push(u.phoneNumber);

    const noToken = await request(app).get('/api/auth/me');
    expect(noToken.status).toBe(401);

    const badToken = await request(app).get('/api/auth/me').set(auth('not.a.jwt'));
    expect(badToken.status).toBe(401);

    const ok = await request(app).get('/api/auth/me').set(auth(u.accessToken));
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(u.userId);
  });

  it('refreshes tokens, and logout revokes the refresh token', async () => {
    const u = await registerUser();
    created.push(u.phoneNumber);

    const refresh1 = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: u.refreshToken });
    expect(refresh1.status).toBe(200);

    const logout = await request(app).post('/api/auth/logout').set(auth(u.accessToken));
    expect(logout.status).toBe(200);

    // The original refresh token is now revoked (tokenVersion bumped).
    const refresh2 = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: u.refreshToken });
    expect(refresh2.status).toBe(401);
  });

  it('password change revokes old refresh tokens but keeps the current session alive', async () => {
    const u = await registerUser();
    created.push(u.phoneNumber);

    const change = await request(app)
      .patch('/api/profile/password')
      .set(auth(u.accessToken))
      .send({ currentPassword: u.password, newPassword: 'brandnewpassword' });
    expect(change.status).toBe(200);
    expect(change.body.accessToken).toBeTruthy();
    expect(change.body.refreshToken).toBeTruthy();

    // Old refresh token no longer works…
    const old = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: u.refreshToken });
    expect(old.status).toBe(401);

    // …but the freshly-returned one does.
    const fresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: change.body.refreshToken });
    expect(fresh.status).toBe(200);
  });

  it('rejects a wrong current password on change', async () => {
    const u = await registerUser();
    created.push(u.phoneNumber);
    const res = await request(app)
      .patch('/api/profile/password')
      .set(auth(u.accessToken))
      .send({ currentPassword: 'definitelywrong', newPassword: 'anothernewpassword' });
    expect(res.status).toBe(401);
  });
});
