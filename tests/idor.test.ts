import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, auth, cleanupUsers, type TestUser } from './helpers';
import { prisma } from '../src/prisma';

let alice: TestUser;
let bob: TestUser;

const vehicleBody = {
  type: 'petrol',
  vehicleType: 'car',
  make: 'Toyota',
  model: 'Corolla',
  year: 2020,
  licensePlate: 'IDOR-1',
  currentMileage: 1000,
};

beforeAll(async () => {
  alice = await registerUser();
  bob = await registerUser();
  // These tests exercise cross-account access, not tier quotas — give both the
  // Pro tier so the multi-vehicle setup isn't capped by the free vehicle limit.
  await prisma.user.updateMany({
    where: { id: { in: [alice.userId, bob.userId] } },
    data: { tier: 'pro' },
  });
});

afterAll(async () => {
  await cleanupUsers(alice.phoneNumber, bob.phoneNumber);
  await prisma.$disconnect();
});

describe('cross-account access control (IDOR/BOLA)', () => {
  it("blocks a user from reading/editing/deleting another user's vehicle", async () => {
    const create = await request(app)
      .post('/api/vehicles')
      .set(auth(alice.accessToken))
      .send(vehicleBody);
    expect(create.status).toBe(201);
    const vehicleId = create.body.vehicle.id;

    // Alice can read her own.
    const aliceRead = await request(app)
      .get(`/api/vehicles/${vehicleId}`)
      .set(auth(alice.accessToken));
    expect(aliceRead.status).toBe(200);

    // Bob cannot read, patch, or delete it.
    const bobRead = await request(app)
      .get(`/api/vehicles/${vehicleId}`)
      .set(auth(bob.accessToken));
    expect(bobRead.status).toBe(404);

    const bobPatch = await request(app)
      .patch(`/api/vehicles/${vehicleId}`)
      .set(auth(bob.accessToken))
      .send({ nickname: 'stolen' });
    expect(bobPatch.status).toBe(404);

    const bobDelete = await request(app)
      .delete(`/api/vehicles/${vehicleId}`)
      .set(auth(bob.accessToken));
    expect(bobDelete.status).toBe(404);

    // And the vehicle is untouched + still owned by Alice.
    const still = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(still?.userId).toBe(alice.userId);
    expect(still?.nickname).not.toBe('stolen');
  });

  it("PUT to another user's vehicle id is forbidden, not a takeover", async () => {
    const create = await request(app)
      .post('/api/vehicles')
      .set(auth(alice.accessToken))
      .send({ ...vehicleBody, licensePlate: 'IDOR-2' });
    const vehicleId = create.body.vehicle.id;

    const bobPut = await request(app)
      .put(`/api/vehicles/${vehicleId}`)
      .set(auth(bob.accessToken))
      .send({ ...vehicleBody, licensePlate: 'HIJACK', nickname: 'bobs now' });
    expect(bobPut.status).toBe(403);

    const still = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(still?.userId).toBe(alice.userId);
  });

  it("backup import cannot overwrite or take over another user's rows by id", async () => {
    // Alice owns a vehicle + a fuel record on it.
    const create = await request(app)
      .post('/api/vehicles')
      .set(auth(alice.accessToken))
      .send({ ...vehicleBody, licensePlate: 'IDOR-3', nickname: 'alice-original' });
    const vehicleId = create.body.vehicle.id;

    const fuelPut = await request(app)
      .put(`/api/fuel-records/${crypto.randomUUID()}`)
      .set(auth(alice.accessToken))
      .send({
        vehicleId,
        date: new Date().toISOString(),
        liters: 30,
        fuelType: 'Petrol 92',
        odometer: 1200,
        pricePerLiter: 340,
        isFullTank: true,
      });
    expect(fuelPut.status).toBe(200);
    const fuelId = fuelPut.body.record.id;

    // Bob crafts an import bundle reusing Alice's vehicle + fuel ids to hijack them.
    const bobImport = await request(app)
      .post('/api/backup/import')
      .set(auth(bob.accessToken))
      .send({
        vehicles: [
          {
            id: vehicleId,
            type: 'diesel',
            vehicleType: 'truck',
            make: 'HIJACKED',
            model: 'HIJACKED',
            year: 2021,
            licensePlate: 'HIJACK',
            currentMileage: 9999,
            nickname: 'bob-stole-this',
          },
        ],
        fuelRecords: [
          {
            id: fuelId,
            vehicleId,
            date: new Date().toISOString(),
            liters: 999,
            fuelType: 'HIJACK',
            odometer: 9999,
            pricePerLiter: 1,
          },
        ],
      });
    expect(bobImport.status).toBe(200);
    // The hijack attempt is silently skipped, not applied.
    expect(bobImport.body.imported.vehicles).toBe(0);
    expect(bobImport.body.imported.fuelRecords).toBe(0);

    // Alice's data is completely unchanged and still hers.
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(vehicle?.userId).toBe(alice.userId);
    expect(vehicle?.make).toBe('Toyota');
    expect(vehicle?.nickname).toBe('alice-original');

    const fuel = await prisma.fuelRecord.findUnique({ where: { id: fuelId } });
    expect(fuel?.userId).toBe(alice.userId);
    expect(fuel?.liters).toBe(30);
  });
});
