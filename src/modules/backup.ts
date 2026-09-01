import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/authenticate';
import { requirePro } from '../middleware/requirePro';
import { validate } from '../middleware/validate';
import { limitsForTier } from '../lib/entitlements';

export const backupRouter = Router();
backupRouter.use(authenticate);

// ── Export ────────────────────────────────────────────────────────────────
// GET /backup/export — the full data bundle for the current user.
backupRouter.get(
  '/backup/export',
  requirePro,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const [profile, preferences, vehicles, fuelRecords, serviceRecords, reminders, documents, driverLicense] =
      await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, displayName: true, phoneNumber: true, profileImageUrl: true, createdAt: true },
        }),
        prisma.userPreferences.findUnique({ where: { userId } }),
        prisma.vehicle.findMany({
          where: { userId },
          orderBy: { sortOrder: 'asc' },
          include: { trackers: { orderBy: { createdAt: 'asc' } } },
        }),
        prisma.fuelRecord.findMany({ where: { userId } }),
        prisma.serviceRecord.findMany({ where: { userId } }),
        prisma.reminder.findMany({ where: { userId } }),
        prisma.document.findMany({ where: { userId } }),
        prisma.driverLicense.findUnique({ where: { userId } }),
      ]);

    res.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      profile,
      preferences,
      vehicles,
      fuelRecords,
      serviceRecords,
      reminders,
      documents,
      driverLicense,
    });
  }),
);

// ── Import ──────────────────────────────────────────────────────────────────
const vehicleItem = z.object({
  id: z.string().uuid(),
  type: z.string(),
  vehicleType: z.string(),
  make: z.string(),
  model: z.string(),
  year: z.number().int(),
  licensePlate: z.string(),
  currentMileage: z.number(),
  colour: z.string().nullable().optional(),
  nickname: z.string().nullable().optional(),
  nextServiceMileage: z.number().nullable().optional(),
  lastServiceMileage: z.number().nullable().optional(),
  serviceStation: z.string().nullable().optional(),
  batteryVoltage: z.number().nullable().optional(),
  engineOilPercentage: z.number().nullable().optional(),
  gearOilStatus: z.string().nullable().optional(),
  tirePressurePsi: z.number().nullable().optional(),
  lastFuelType: z.string().nullable().optional(),
  lastPricePerLiter: z.number().nullable().optional(),
  batteryCapacityKwh: z.number().nullable().optional(),
  sortOrder: z.number().int().optional(),
  trackers: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        lastServiceDate: z.coerce.date().nullable().optional(),
        lastServiceMileage: z.number().nullable().optional(),
        nextServiceDate: z.coerce.date().nullable().optional(),
        nextServiceMileage: z.number().nullable().optional(),
      }),
    )
    .optional()
    .default([]),
});

const fuelItem = z.object({
  id: z.string().uuid(),
  vehicleId: z.string().uuid(),
  date: z.coerce.date(),
  liters: z.number(),
  fuelType: z.string(),
  odometer: z.number(),
  pricePerLiter: z.number(),
  stationName: z.string().nullable().optional(),
  isFullTank: z.boolean().optional().default(false),
});

const serviceItem = z.object({
  id: z.string().uuid(),
  vehicleId: z.string().uuid(),
  dateOfService: z.coerce.date(),
  serviceType: z.string(),
  mileageAtService: z.number(),
  cost: z.number().nullable().optional(),
  serviceStation: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  nextServiceMileage: z.number().nullable().optional(),
});

const reminderItem = z.object({
  id: z.string().uuid(),
  vehicleId: z.string().uuid(),
  serviceType: z.string(),
  triggerType: z.enum(['days', 'mileage']),
  triggerValue: z.number(),
  notes: z.string().nullable().optional(),
  preferredServiceProvider: z.string().nullable().optional(),
  isDone: z.boolean().optional().default(false),
});

const documentItem = z.object({
  id: z.string().uuid(),
  title: z.string(),
  documentType: z.enum(['driversLicense', 'revenueLicense', 'insurance', 'registration', 'emissionTest', 'other']),
  expiryDate: z.coerce.date().nullable().optional(),
});

const licenseItem = z.object({
  fullName: z.string(),
  licenseNumber: z.string(),
  dateOfBirth: z.coerce.date().nullable().optional(),
  licenceClass: z.string().optional().default(''),
  address: z.string().optional().default(''),
  issuedDate: z.coerce.date().nullable().optional(),
  expiryDate: z.coerce.date().nullable().optional(),
});

const importSchema = z.object({
  profile: z
    .object({
      displayName: z.string().optional(),
      // Phone number is the login credential — never cleared on import.
      phoneNumber: z.string().min(5).optional(),
    })
    .optional(),
  preferences: z
    .object({
      distanceUnit: z.string().optional(),
      fuelVolumeUnit: z.string().optional(),
      currency: z.string().optional(),
      autoBackupEnabled: z.boolean().optional(),
      backupFrequency: z.string().optional(),
    })
    .optional(),
  vehicles: z.array(vehicleItem).optional().default([]),
  fuelRecords: z.array(fuelItem).optional().default([]),
  serviceRecords: z.array(serviceItem).optional().default([]),
  reminders: z.array(reminderItem).optional().default([]),
  documents: z.array(documentItem).optional().default([]),
  driverLicense: licenseItem.nullable().optional(),
});

// POST /backup/import — upsert an exported bundle into the current account.
// Everything is re-owned by the authenticated user; child rows referencing an
// unknown vehicle are skipped rather than failing the whole import.
backupRouter.post(
  '/backup/import',
  requirePro,
  validate({ body: importSchema }),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const b = req.body as z.infer<typeof importSchema>;

    const summary = await prisma.$transaction(async (tx) => {
      if (b.profile) {
        await tx.user.update({ where: { id: userId }, data: b.profile });
      }
      if (b.preferences) {
        await tx.userPreferences.upsert({
          where: { userId },
          create: { userId, ...b.preferences },
          update: b.preferences,
        });
      }

      // Plan limits apply to imports too, so a backup can't be used to exceed
      // the tier's caps. Only *new* rows count; existing rows update freely.
      const { tier } = (await tx.user.findUnique({
        where: { id: userId },
        select: { tier: true },
      })) ?? { tier: 'free' as const };
      const limits = limitsForTier(tier);
      let vehicleCount = await tx.vehicle.count({ where: { userId } });

      // IDOR guard: these upserts key on client-supplied primary keys. Before
      // touching any id, confirm it isn't already owned by a *different*
      // account — otherwise a crafted import could overwrite / take over
      // another user's rows just by knowing their UUIDs. Rows owned by someone
      // else are skipped, exactly like orphaned child rows below.

      // Vehicles + their trackers.
      let vehiclesImported = 0;
      for (const [index, v] of b.vehicles.entries()) {
        const { trackers, ...vehicle } = v;
        const owner = await tx.vehicle.findUnique({
          where: { id: vehicle.id },
          select: { userId: true },
        });
        if (owner && owner.userId !== userId) continue;
        const isNewVehicle = !owner;
        // Skip new vehicles that would exceed the tier's vehicle cap.
        if (isNewVehicle && limits.maxVehicles !== null && vehicleCount >= limits.maxVehicles) {
          continue;
        }
        await tx.vehicle.upsert({
          where: { id: vehicle.id },
          create: { ...vehicle, userId, sortOrder: vehicle.sortOrder ?? index },
          update: { ...vehicle, userId },
        });
        if (isNewVehicle) vehicleCount++;
        vehiclesImported++;

        let trackerCount = await tx.trackerItem.count({ where: { vehicleId: vehicle.id } });
        for (const t of trackers) {
          // A tracker id belonging to another account's vehicle must not be
          // overwritten, so resolve ownership through the parent vehicle.
          const existingTracker = await tx.trackerItem.findUnique({
            where: { id: t.id },
            select: { vehicle: { select: { userId: true } } },
          });
          if (existingTracker && existingTracker.vehicle.userId !== userId) continue;
          const isNewTracker = !existingTracker;
          if (
            isNewTracker &&
            limits.maxTrackersPerVehicle !== null &&
            trackerCount >= limits.maxTrackersPerVehicle
          ) {
            continue;
          }
          await tx.trackerItem.upsert({
            where: { id: t.id },
            create: { ...t, vehicleId: vehicle.id },
            update: t,
          });
          if (isNewTracker) trackerCount++;
        }
      }

      // Set of vehicle ids the user owns after the upserts — used to skip
      // orphaned child rows safely.
      const owned = new Set(
        (await tx.vehicle.findMany({ where: { userId }, select: { id: true } })).map((v) => v.id),
      );

      let fuel = 0;
      for (const r of b.fuelRecords) {
        if (!owned.has(r.vehicleId)) continue;
        const owner = await tx.fuelRecord.findUnique({ where: { id: r.id }, select: { userId: true } });
        if (owner && owner.userId !== userId) continue;
        await tx.fuelRecord.upsert({
          where: { id: r.id },
          create: { ...r, userId },
          update: { ...r, userId },
        });
        fuel++;
      }

      let service = 0;
      for (const r of b.serviceRecords) {
        if (!owned.has(r.vehicleId)) continue;
        const owner = await tx.serviceRecord.findUnique({ where: { id: r.id }, select: { userId: true } });
        if (owner && owner.userId !== userId) continue;
        await tx.serviceRecord.upsert({
          where: { id: r.id },
          create: { ...r, userId },
          update: { ...r, userId },
        });
        service++;
      }

      let reminders = 0;
      for (const r of b.reminders) {
        if (!owned.has(r.vehicleId)) continue;
        const owner = await tx.reminder.findUnique({ where: { id: r.id }, select: { userId: true } });
        if (owner && owner.userId !== userId) continue;
        await tx.reminder.upsert({
          where: { id: r.id },
          create: { ...r, userId },
          update: { ...r, userId },
        });
        reminders++;
      }

      let documents = 0;
      for (const d of b.documents) {
        const owner = await tx.document.findUnique({ where: { id: d.id }, select: { userId: true } });
        if (owner && owner.userId !== userId) continue;
        await tx.document.upsert({
          where: { id: d.id },
          create: { ...d, userId },
          update: { ...d, userId },
        });
        documents++;
      }

      if (b.driverLicense) {
        await tx.driverLicense.upsert({
          where: { userId },
          create: { ...b.driverLicense, userId },
          update: b.driverLicense,
        });
      }

      return {
        vehicles: vehiclesImported,
        fuelRecords: fuel,
        serviceRecords: service,
        reminders,
        documents,
      };
    });

    res.json({ ok: true, imported: summary });
  }),
);

// ── Sync ──────────────────────────────────────────────────────────────────
const syncQuery = z.object({ since: z.coerce.date().optional() });

// GET /sync?since=<ISO timestamp> — everything changed since `since` (or all,
// if omitted). `serverTime` is the cursor to pass as `since` next time.
// NOTE: deletions are not tracked yet (would need tombstones); this returns
// created/updated rows only.
backupRouter.get(
  '/sync',
  validate({ query: syncQuery }),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const since = req.query.since ? new Date(req.query.since as unknown as string) : undefined;
    const updatedFilter = since ? { updatedAt: { gt: since } } : {};

    const [vehicles, trackers, fuelRecords, serviceRecords, reminders, documents, driverLicense, preferences, deletions] =
      await Promise.all([
        prisma.vehicle.findMany({ where: { userId, ...updatedFilter } }),
        prisma.trackerItem.findMany({ where: { vehicle: { userId }, ...updatedFilter } }),
        prisma.fuelRecord.findMany({ where: { userId, ...updatedFilter } }),
        prisma.serviceRecord.findMany({ where: { userId, ...updatedFilter } }),
        prisma.reminder.findMany({ where: { userId, ...updatedFilter } }),
        prisma.document.findMany({ where: { userId, ...updatedFilter } }),
        prisma.driverLicense.findFirst({ where: { userId, ...updatedFilter } }),
        prisma.userPreferences.findFirst({ where: { userId, ...updatedFilter } }),
        // Deletions only matter for a delta sync — a first (full) sync has no
        // local rows to remove.
        since
          ? prisma.tombstone.findMany({
              where: { userId, deletedAt: { gt: since } },
              select: { entityType: true, entityId: true, deletedAt: true },
              orderBy: { deletedAt: 'asc' },
            })
          : Promise.resolve([]),
      ]);

    res.json({
      serverTime: new Date().toISOString(),
      since: since?.toISOString() ?? null,
      changes: { vehicles, trackers, fuelRecords, serviceRecords, reminders, documents, driverLicense, preferences },
      deletions,
    });
  }),
);
