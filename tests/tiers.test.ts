import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, auth, cleanupUsers, type TestUser } from './helpers';
import { prisma } from '../src/prisma';
import { TIER_LIMITS } from '../src/lib/entitlements';

const phones: string[] = [];
afterAll(async () => {
  await cleanupUsers(...phones);
  await prisma.$disconnect();
});

const vehicle = (plate: string) => ({
  type: 'petrol',
  vehicleType: 'car',
  make: 'Toyota',
  model: 'Corolla',
  year: 2020,
  licensePlate: plate,
  currentMileage: 1000,
});

async function makePro(u: TestUser) {
  await prisma.user.update({ where: { id: u.userId }, data: { tier: 'pro' } });
}

describe('subscription tier limits', () => {
  it('exposes tier, limits and usage on /auth/me', async () => {
    const u = await registerUser();
    phones.push(u.phoneNumber);

    const res = await request(app).get('/api/auth/me').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user.tier).toBe('free');
    expect(res.body.entitlements.tier).toBe('free');
    expect(res.body.entitlements.limits.maxVehicles).toBe(TIER_LIMITS.free.maxVehicles);
    expect(res.body.entitlements.usage.vehicles).toBe(0);
  });

  it('caps a free account at its vehicle limit with a 402', async () => {
    const u = await registerUser();
    phones.push(u.phoneNumber);

    // Free = 1 vehicle: the first is allowed.
    const first = await request(app)
      .post('/api/vehicles')
      .set(auth(u.accessToken))
      .send(vehicle('TIER-A1'));
    expect(first.status).toBe(201);

    // The second is refused with an upgrade signal the app turns into a paywall.
    const second = await request(app)
      .post('/api/vehicles')
      .set(auth(u.accessToken))
      .send(vehicle('TIER-A2'));
    expect(second.status).toBe(402);
    expect(second.body.error.code).toBe('UPGRADE_REQUIRED');
  });

  it('lets a Pro account add more vehicles than Free', async () => {
    const u = await registerUser();
    phones.push(u.phoneNumber);
    await makePro(u);

    for (let i = 1; i <= 3; i++) {
      const res = await request(app)
        .post('/api/vehicles')
        .set(auth(u.accessToken))
        .send(vehicle(`TIER-P${i}`));
      expect(res.status).toBe(201);
    }
  });

  it('caps trackers per vehicle on Free but not on Pro', async () => {
    const u = await registerUser();
    phones.push(u.phoneNumber);

    const v = await request(app)
      .post('/api/vehicles')
      .set(auth(u.accessToken))
      .send(vehicle('TIER-T1'));
    const vehicleId = v.body.vehicle.id;
    const cap = TIER_LIMITS.free.maxTrackersPerVehicle as number;

    // Fill exactly up to the cap (the app's default trackers must fit here).
    for (let i = 0; i < cap; i++) {
      const res = await request(app)
        .post(`/api/vehicles/${vehicleId}/trackers`)
        .set(auth(u.accessToken))
        .send({ name: `Tracker ${i}` });
      expect(res.status).toBe(201);
    }
    // One past the cap is refused.
    const over = await request(app)
      .post(`/api/vehicles/${vehicleId}/trackers`)
      .set(auth(u.accessToken))
      .send({ name: 'One too many' });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('UPGRADE_REQUIRED');

    // Upgrading to Pro lifts the cap.
    await makePro(u);
    const afterUpgrade = await request(app)
      .post(`/api/vehicles/${vehicleId}/trackers`)
      .set(auth(u.accessToken))
      .send({ name: 'Now allowed' });
    expect(afterUpgrade.status).toBe(201);
  });

  it('caps reminders on Free', async () => {
    const u = await registerUser();
    phones.push(u.phoneNumber);
    const v = await request(app)
      .post('/api/vehicles')
      .set(auth(u.accessToken))
      .send(vehicle('TIER-R1'));
    const vehicleId = v.body.vehicle.id;
    const cap = TIER_LIMITS.free.maxReminders as number;

    for (let i = 0; i < cap; i++) {
      const res = await request(app)
        .put(`/api/reminders/${crypto.randomUUID()}`)
        .set(auth(u.accessToken))
        .send({ vehicleId, serviceType: `Service ${i}`, triggerType: 'days', triggerValue: 30 });
      expect(res.status).toBe(200);
    }
    const over = await request(app)
      .put(`/api/reminders/${crypto.randomUUID()}`)
      .set(auth(u.accessToken))
      .send({ vehicleId, serviceType: 'Over', triggerType: 'days', triggerValue: 30 });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('UPGRADE_REQUIRED');
  });

  it('caps documents on Free', async () => {
    const u = await registerUser();
    phones.push(u.phoneNumber);
    const cap = TIER_LIMITS.free.maxDocuments as number;

    for (let i = 0; i < cap; i++) {
      const res = await request(app)
        .post('/api/documents')
        .set(auth(u.accessToken))
        .send({ title: `Doc ${i}`, documentType: 'insurance' });
      expect(res.status).toBe(201);
    }
    const over = await request(app)
      .post('/api/documents')
      .set(auth(u.accessToken))
      .send({ title: 'Over', documentType: 'insurance' });
    expect(over.status).toBe(402);
  });

  it('gates backup export/import behind Pro, but leaves /sync free', async () => {
    const u = await registerUser();
    phones.push(u.phoneNumber);

    // Free: backup is Pro-only…
    const exportFree = await request(app)
      .get('/api/backup/export')
      .set(auth(u.accessToken));
    expect(exportFree.status).toBe(402);
    expect(exportFree.body.error.code).toBe('UPGRADE_REQUIRED');

    const importFree = await request(app)
      .post('/api/backup/import')
      .set(auth(u.accessToken))
      .send({ vehicles: [] });
    expect(importFree.status).toBe(402);

    // …but delta sync stays available on Free.
    const syncFree = await request(app).get('/api/sync').set(auth(u.accessToken));
    expect(syncFree.status).toBe(200);

    // Pro unlocks backup.
    await makePro(u);
    const exportPro = await request(app)
      .get('/api/backup/export')
      .set(auth(u.accessToken));
    expect(exportPro.status).toBe(200);
  });

  it('updating an existing vehicle does not count against the quota', async () => {
    const u = await registerUser();
    phones.push(u.phoneNumber);

    const v = await request(app)
      .post('/api/vehicles')
      .set(auth(u.accessToken))
      .send(vehicle('TIER-U1'));
    const id = v.body.vehicle.id;

    // PATCH/PUT on the one existing vehicle must keep working at the cap.
    const patch = await request(app)
      .patch(`/api/vehicles/${id}`)
      .set(auth(u.accessToken))
      .send({ nickname: 'still fine' });
    expect(patch.status).toBe(200);
  });
});
