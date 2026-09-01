import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { authenticate } from '../middleware/authenticate';
import { requireAdmin } from '../middleware/requireAdmin';
import { validate } from '../middleware/validate';

// Cross-account endpoints backing the manager dashboard.
//
// Everything here aggregates **in the database**. The point is that a response
// stays the same size whether the platform has ten users or ten million — no
// endpoint in this module ever streams whole record tables to the client.
export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

// Postgres COUNT() comes back as bigint, which JSON.stringify refuses to
// serialise. Every raw-query count goes through here.
const toNumber = (value: bigint | number) => Number(value);

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

// ── Stats ──────────────────────────────────────────────────────────────────
const statsQuery = z.object({
  // Length of the activity series. Capped so one request can't ask for years.
  days: z.coerce.number().int().min(1).max(90).optional().default(14),
});

interface DayCountRow {
  day: Date;
  count: bigint;
}

// GET /admin/stats — platform-wide totals, growth, breakdown and activity.
adminRouter.get(
  '/stats',
  validate({ query: statsQuery }),
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days ?? 14);
    const since = daysAgo(days - 1);
    const last7 = daysAgo(7);
    const last30 = daysAgo(30);

    const [
      users,
      vehicles,
      fuelRecords,
      serviceRecords,
      reminders,
      documents,
      trackers,
      newUsers7,
      newUsers30,
      remindersOutstanding,
      vehiclesByCategory,
      vehiclesByPowertrain,
      fuelByDay,
      serviceByDay,
      usersByDay,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.vehicle.count(),
      prisma.fuelRecord.count(),
      prisma.serviceRecord.count(),
      prisma.reminder.count(),
      prisma.document.count(),
      prisma.trackerItem.count(),
      prisma.user.count({ where: { createdAt: { gte: last7 } } }),
      prisma.user.count({ where: { createdAt: { gte: last30 } } }),
      prisma.reminder.count({ where: { isDone: false } }),
      prisma.vehicle.groupBy({ by: ['vehicleType'], _count: { _all: true } }),
      prisma.vehicle.groupBy({ by: ['type'], _count: { _all: true } }),
      // Grouped in the DB rather than by pulling rows and counting in JS.
      prisma.$queryRaw<DayCountRow[]>`
        SELECT date_trunc('day', "date") AS day, COUNT(*)::bigint AS count
        FROM fuel_records WHERE "date" >= ${since}
        GROUP BY 1 ORDER BY 1
      `,
      prisma.$queryRaw<DayCountRow[]>`
        SELECT date_trunc('day', "dateOfService") AS day, COUNT(*)::bigint AS count
        FROM service_records WHERE "dateOfService" >= ${since}
        GROUP BY 1 ORDER BY 1
      `,
      prisma.$queryRaw<DayCountRow[]>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM users WHERE "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1
      `,
    ]);

    // Zero-fill the series so a quiet day is a zero, not a missing point.
    // Day keys are UTC — see the note in the API docs.
    const key = (d: Date) => d.toISOString().slice(0, 10);
    const index = (rows: DayCountRow[]) =>
      new Map(rows.map((r) => [key(new Date(r.day)), toNumber(r.count)]));

    const fuelIndex = index(fuelByDay);
    const serviceIndex = index(serviceByDay);
    const usersIndex = index(usersByDay);

    const activity = Array.from({ length: days }, (_, i) => {
      const day = daysAgo(days - 1 - i);
      const k = key(day);
      const fuel = fuelIndex.get(k) ?? 0;
      const service = serviceIndex.get(k) ?? 0;
      return { day: k, fuel, service, records: fuel + service, newUsers: usersIndex.get(k) ?? 0 };
    });

    res.json({
      stats: {
        users,
        vehicles,
        fuelRecords,
        serviceRecords,
        reminders,
        documents,
        trackers,
        records: fuelRecords + serviceRecords,
        newUsersLast7Days: newUsers7,
        newUsersLast30Days: newUsers30,
        remindersOutstanding,
        vehiclesPerUser: users > 0 ? vehicles / users : 0,
      },
      vehiclesByCategory: vehiclesByCategory
        .map((row) => ({ key: row.vehicleType, count: row._count._all }))
        .sort((a, b) => b.count - a.count),
      vehiclesByPowertrain: vehiclesByPowertrain
        .map((row) => ({ key: row.type, count: row._count._all }))
        .sort((a, b) => b.count - a.count),
      activity,
      days,
    });
  }),
);

// ── Users ──────────────────────────────────────────────────────────────────
const usersQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  // Hard ceiling — the page size is the client's, but the limit is ours.
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(['createdAt', 'phoneNumber', 'displayName']).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

const userSelect = {
  id: true,
  displayName: true,
  phoneNumber: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  // Counted by Postgres per row; never the underlying records.
  _count: {
    select: {
      vehicles: true,
      fuelRecords: true,
      serviceRecords: true,
      reminders: true,
      documents: true,
    },
  },
} as const;

// GET /admin/users — paginated directory. `passwordHash` is never selected.
adminRouter.get(
  '/users',
  validate({ query: usersQuery }),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 25);
    const q = (req.query.q as string | undefined)?.trim();
    const sort = (req.query.sort as string) ?? 'createdAt';
    const order = (req.query.order as 'asc' | 'desc') ?? 'desc';

    const where = q
      ? {
          OR: [
            { phoneNumber: { contains: q, mode: 'insensitive' as const } },
            { displayName: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: { [sort]: order },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      users,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  }),
);

// GET /admin/users/:id — one account, with its vehicles.
adminRouter.get(
  '/users/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        ...userSelect,
        preferences: true,
        vehicles: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            make: true,
            model: true,
            year: true,
            licensePlate: true,
            nickname: true,
            vehicleType: true,
            type: true,
            currentMileage: true,
            createdAt: true,
          },
        },
      },
    });
    if (!user) throw ApiError.notFound('User not found');
    res.json({ user });
  }),
);

// GET /admin/users/:id/analytics — per-account fuel & service analytics for the
// user-detail drill-down. Oil-type analytics are intentionally omitted until the
// schema/sync carries `oilType`.
adminRouter.get(
  '/users/:id/analytics',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!exists) throw ApiError.notFound('User not found');

    const [fuelAgg, serviceAgg, economy, spendRow] = await Promise.all([
      prisma.fuelRecord.aggregate({ where: { userId }, _sum: { liters: true }, _count: { _all: true } }),
      prisma.serviceRecord.aggregate({ where: { userId }, _sum: { cost: true }, _count: { _all: true } }),
      fuelEconomyL100km(userId),
      prisma.$queryRaw<{ spend: number }[]>`
        SELECT COALESCE(SUM(liters * "pricePerLiter"), 0)::float8 AS spend
        FROM fuel_records WHERE "userId" = ${userId}
      `,
    ]);

    res.json({
      analytics: {
        fuel: {
          liters: fuelAgg._sum.liters ?? 0,
          spend: Number(spendRow[0]?.spend ?? 0),
          records: fuelAgg._count._all,
          avgEconomyL100km: economy,
        },
        service: {
          spend: serviceAgg._sum.cost ?? 0,
          records: serviceAgg._count._all,
        },
      },
    });
  }),
);

// ── Vehicles (cross-account fleet) ───────────────────────────────────────────
const vehiclesQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  q: z.string().trim().max(120).optional(),
  type: z.string().trim().max(40).optional(),
  vehicleType: z.string().trim().max(40).optional(),
  userId: z.string().uuid().optional(),
  sort: z.enum(['createdAt', 'year', 'currentMileage', 'make']).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

interface BandRow {
  band: string;
  count: bigint;
}

const MILEAGE_BAND_ORDER = ['0-25k', '25-50k', '50-100k', '100-200k', '200k+'];
const AGE_BAND_ORDER = ['0-2', '3-5', '6-10', '11-15', '16+'];

// GET /admin/vehicles — paginated cross-account fleet + platform breakdowns.
adminRouter.get(
  '/vehicles',
  validate({ query: vehiclesQuery }),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 25);
    const q = (req.query.q as string | undefined)?.trim();
    const type = req.query.type as string | undefined;
    const vehicleType = req.query.vehicleType as string | undefined;
    const userId = req.query.userId as string | undefined;
    const sort = (req.query.sort as string) ?? 'createdAt';
    const order = (req.query.order as 'asc' | 'desc') ?? 'desc';

    const where: Prisma.VehicleWhereInput = {
      ...(type ? { type } : {}),
      ...(vehicleType ? { vehicleType } : {}),
      ...(userId ? { userId } : {}),
      ...(q
        ? {
            OR: [
              { make: { contains: q, mode: 'insensitive' as const } },
              { model: { contains: q, mode: 'insensitive' as const } },
              { licensePlate: { contains: q, mode: 'insensitive' as const } },
              { nickname: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [total, rows, byPowertrain, byCategory, mileageBands, ageBands, lowOil, overdueRows] =
      await Promise.all([
        prisma.vehicle.count({ where }),
        prisma.vehicle.findMany({
          where,
          orderBy: { [sort]: order },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            make: true,
            model: true,
            year: true,
            licensePlate: true,
            nickname: true,
            colour: true,
            vehicleType: true,
            type: true,
            currentMileage: true,
            nextServiceMileage: true,
            lastServiceMileage: true,
            engineOilPercentage: true,
            batteryVoltage: true,
            tirePressurePsi: true,
            lastFuelType: true,
            lastPricePerLiter: true,
            createdAt: true,
            user: { select: { id: true, phoneNumber: true, displayName: true } },
          },
        }),
        // Platform-wide breakdowns (unfiltered) — cheap groupings, not row streams.
        prisma.vehicle.groupBy({ by: ['type'], _count: { _all: true } }),
        prisma.vehicle.groupBy({ by: ['vehicleType'], _count: { _all: true } }),
        prisma.$queryRaw<BandRow[]>`
          SELECT CASE
            WHEN "currentMileage" < 25000 THEN '0-25k'
            WHEN "currentMileage" < 50000 THEN '25-50k'
            WHEN "currentMileage" < 100000 THEN '50-100k'
            WHEN "currentMileage" < 200000 THEN '100-200k'
            ELSE '200k+' END AS band,
            COUNT(*)::bigint AS count
          FROM vehicles GROUP BY 1
        `,
        prisma.$queryRaw<BandRow[]>`
          SELECT CASE
            WHEN (EXTRACT(YEAR FROM now()) - "year") <= 2 THEN '0-2'
            WHEN (EXTRACT(YEAR FROM now()) - "year") <= 5 THEN '3-5'
            WHEN (EXTRACT(YEAR FROM now()) - "year") <= 10 THEN '6-10'
            WHEN (EXTRACT(YEAR FROM now()) - "year") <= 15 THEN '11-15'
            ELSE '16+' END AS band,
            COUNT(*)::bigint AS count
          FROM vehicles GROUP BY 1
        `,
        prisma.vehicle.count({ where: { engineOilPercentage: { lt: 20 } } }),
        prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint AS count FROM vehicles
          WHERE "nextServiceMileage" IS NOT NULL AND "currentMileage" >= "nextServiceMileage"
        `,
      ]);

    const orderBands = (bandRows: BandRow[], orderArr: string[]) => {
      const m = new Map(bandRows.map((r) => [r.band, toNumber(r.count)]));
      return orderArr.map((k) => ({ key: k, count: m.get(k) ?? 0 }));
    };

    res.json({
      vehicles: rows.map(({ user, ...rest }) => ({ ...rest, owner: user })),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      breakdowns: {
        byPowertrain: byPowertrain
          .map((r) => ({ key: r.type, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
        byCategory: byCategory
          .map((r) => ({ key: r.vehicleType, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
        mileageBands: orderBands(mileageBands, MILEAGE_BAND_ORDER),
        ageDistribution: orderBands(ageBands, AGE_BAND_ORDER),
        conditionFlags: {
          lowOilPercentage: lowOil,
          overdueService: toNumber(overdueRows[0]?.count ?? 0n),
        },
      },
    });
  }),
);

// GET /admin/vehicles/:id — one vehicle with owner + bounded recent history.
// Internal disk paths (attachmentPath) are never selected.
adminRouter.get(
  '/vehicles/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, phoneNumber: true, displayName: true } },
        trackers: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            lastServiceDate: true,
            lastServiceMileage: true,
            nextServiceDate: true,
            nextServiceMileage: true,
          },
        },
        fuelRecords: {
          orderBy: { date: 'desc' },
          take: 20,
          select: {
            id: true,
            date: true,
            liters: true,
            fuelType: true,
            odometer: true,
            pricePerLiter: true,
            stationName: true,
            isFullTank: true,
          },
        },
        serviceRecords: {
          orderBy: { dateOfService: 'desc' },
          take: 20,
          select: {
            id: true,
            dateOfService: true,
            serviceType: true,
            mileageAtService: true,
            cost: true,
            serviceStation: true,
            notes: true,
            nextServiceMileage: true,
            attachmentUrl: true,
            attachmentFileName: true,
          },
        },
        reminders: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            serviceType: true,
            triggerType: true,
            triggerValue: true,
            notes: true,
            preferredServiceProvider: true,
            isDone: true,
          },
        },
      },
    });
    if (!vehicle) throw ApiError.notFound('Vehicle not found');
    const { user, ...rest } = vehicle;
    res.json({ vehicle: { ...rest, owner: user } });
  }),
);

// ── Fuel & service analytics ─────────────────────────────────────────────────
const analyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

/**
 * Platform (or per-user) fuel economy in L/100km, derived only from
 * brim-to-brim (full-tank) intervals. For each full-tank fill-up we take the
 * distance since the previous full tank and sum the litres put in across that
 * interval (partials included). Distance/outlier guards drop odometer resets.
 */
async function fuelEconomyL100km(userId?: string): Promise<number | null> {
  const outer = userId ? Prisma.sql`AND "userId" = ${userId}` : Prisma.empty;
  const inner = userId ? Prisma.sql`AND fr."userId" = ${userId}` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ total_liters: number; total_distance: number }[]>(Prisma.sql`
    WITH full_tanks AS (
      SELECT "vehicleId", odometer,
             LAG(odometer) OVER (PARTITION BY "vehicleId" ORDER BY odometer) AS prev_odo
      FROM fuel_records
      WHERE "isFullTank" = true ${outer}
    ),
    intervals AS (
      SELECT (ft.odometer - ft.prev_odo) AS distance,
             (SELECT COALESCE(SUM(fr.liters), 0) FROM fuel_records fr
                WHERE fr."vehicleId" = ft."vehicleId"
                  AND fr.odometer > ft.prev_odo AND fr.odometer <= ft.odometer ${inner}) AS liters
      FROM full_tanks ft
      WHERE ft.prev_odo IS NOT NULL AND ft.odometer > ft.prev_odo
    )
    SELECT COALESCE(SUM(liters), 0)::float8 AS total_liters,
           COALESCE(SUM(distance), 0)::float8 AS total_distance
    FROM intervals WHERE distance > 0 AND distance < 5000
  `);
  const r = rows[0];
  const liters = r ? Number(r.total_liters) : 0;
  const distance = r ? Number(r.total_distance) : 0;
  return distance > 0 ? (100 * liters) / distance : null;
}

// GET /admin/fuel-analytics — platform consumption, spend, price trend, economy.
adminRouter.get(
  '/fuel-analytics',
  validate({ query: analyticsQuery }),
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days ?? 30);
    const since = daysAgo(days - 1);

    const [agg, spendRow, byFuelType, byPowertrainRows, topStations, priceTrend, economy] =
      await Promise.all([
        prisma.fuelRecord.aggregate({ _sum: { liters: true }, _count: { _all: true } }),
        prisma.$queryRaw<{ spend: number }[]>`
          SELECT COALESCE(SUM(liters * "pricePerLiter"), 0)::float8 AS spend FROM fuel_records
        `,
        prisma.fuelRecord.groupBy({
          by: ['fuelType'],
          _sum: { liters: true },
          _count: { _all: true },
        }),
        prisma.$queryRaw<{ type: string; liters: number }[]>`
          SELECT v."type" AS type, COALESCE(SUM(fr.liters), 0)::float8 AS liters
          FROM fuel_records fr JOIN vehicles v ON v.id = fr."vehicleId"
          GROUP BY v."type" ORDER BY liters DESC
        `,
        prisma.fuelRecord.groupBy({
          by: ['stationName'],
          _count: { _all: true },
          _sum: { liters: true },
          where: { stationName: { not: null } },
          orderBy: { _count: { stationName: 'desc' } },
          take: 8,
        }),
        prisma.$queryRaw<{ day: Date; avg_price: number; liters: number }[]>`
          SELECT date_trunc('day', "date") AS day,
                 AVG("pricePerLiter")::float8 AS avg_price,
                 SUM(liters)::float8 AS liters
          FROM fuel_records WHERE "date" >= ${since} GROUP BY 1 ORDER BY 1
        `,
        fuelEconomyL100km(),
      ]);

    const key = (d: Date) => d.toISOString().slice(0, 10);
    const priceIndex = new Map(
      priceTrend.map((r) => [
        key(new Date(r.day)),
        { avgPrice: Number(r.avg_price), liters: Number(r.liters) },
      ]),
    );
    const trend = Array.from({ length: days }, (_, i) => {
      const day = daysAgo(days - 1 - i);
      const k = key(day);
      const e = priceIndex.get(k);
      return { day: k, avgPrice: e?.avgPrice ?? null, liters: e?.liters ?? 0 };
    });

    res.json({
      totals: {
        liters: agg._sum.liters ?? 0,
        spend: Number(spendRow[0]?.spend ?? 0),
        records: agg._count._all,
        avgEconomyL100km: economy,
      },
      byFuelType: byFuelType
        .map((r) => ({ key: r.fuelType, liters: r._sum.liters ?? 0, count: r._count._all }))
        .sort((a, b) => b.liters - a.liters),
      byPowertrain: byPowertrainRows.map((r) => ({ key: r.type, liters: Number(r.liters) })),
      topStations: topStations.map((r) => ({
        key: r.stationName ?? 'Unknown',
        count: r._count._all,
        liters: r._sum.liters ?? 0,
      })),
      priceTrend: trend,
      days,
    });
  }),
);

// GET /admin/service-analytics — platform service spend, cost-by-type, frequency.
adminRouter.get(
  '/service-analytics',
  validate({ query: analyticsQuery }),
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days ?? 30);
    const since = daysAgo(days - 1);

    const [agg, costByType, topStations, spendTrend, avgBetween, dueRows] = await Promise.all([
      prisma.serviceRecord.aggregate({ _sum: { cost: true }, _count: { _all: true } }),
      prisma.serviceRecord.groupBy({
        by: ['serviceType'],
        _sum: { cost: true },
        _count: { _all: true },
      }),
      prisma.serviceRecord.groupBy({
        by: ['serviceStation'],
        _count: { _all: true },
        _sum: { cost: true },
        where: { serviceStation: { not: null } },
        orderBy: { _count: { serviceStation: 'desc' } },
        take: 8,
      }),
      prisma.$queryRaw<{ day: Date; cost: number; count: bigint }[]>`
        SELECT date_trunc('day', "dateOfService") AS day,
               COALESCE(SUM(cost), 0)::float8 AS cost,
               COUNT(*)::bigint AS count
        FROM service_records WHERE "dateOfService" >= ${since} GROUP BY 1 ORDER BY 1
      `,
      prisma.$queryRaw<{ avg_delta: number | null }[]>`
        WITH ordered AS (
          SELECT "vehicleId", "mileageAtService",
                 LAG("mileageAtService") OVER (PARTITION BY "vehicleId" ORDER BY "mileageAtService") AS prev
          FROM service_records
        )
        SELECT AVG("mileageAtService" - prev)::float8 AS avg_delta
        FROM ordered
        WHERE prev IS NOT NULL AND "mileageAtService" > prev AND ("mileageAtService" - prev) < 100000
      `,
      prisma.$queryRaw<{ due: bigint; overdue: bigint }[]>`
        SELECT
          (COUNT(*) FILTER (WHERE "nextServiceMileage" - "currentMileage" BETWEEN 0 AND 1000))::bigint AS due,
          (COUNT(*) FILTER (WHERE "currentMileage" >= "nextServiceMileage"))::bigint AS overdue
        FROM vehicles WHERE "nextServiceMileage" IS NOT NULL
      `,
    ]);

    const key = (d: Date) => d.toISOString().slice(0, 10);
    const idx = new Map(
      spendTrend.map((r) => [key(new Date(r.day)), { cost: Number(r.cost), count: toNumber(r.count) }]),
    );
    const trend = Array.from({ length: days }, (_, i) => {
      const day = daysAgo(days - 1 - i);
      const k = key(day);
      const e = idx.get(k);
      return { day: k, cost: e?.cost ?? 0, count: e?.count ?? 0 };
    });

    res.json({
      totals: {
        spend: agg._sum.cost ?? 0,
        records: agg._count._all,
        avgMileageBetweenServices:
          avgBetween[0]?.avg_delta != null ? Number(avgBetween[0].avg_delta) : null,
        dueSoon: toNumber(dueRows[0]?.due ?? 0n),
        overdue: toNumber(dueRows[0]?.overdue ?? 0n),
      },
      costByType: costByType
        .map((r) => ({ key: r.serviceType, cost: r._sum.cost ?? 0, count: r._count._all }))
        .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
      topStations: topStations.map((r) => ({
        key: r.serviceStation ?? 'Unknown',
        count: r._count._all,
        cost: r._sum.cost ?? 0,
      })),
      spendTrend: trend,
      days,
    });
  }),
);

// ── Reminders (cross-account) ────────────────────────────────────────────────
const remindersQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  isDone: z.enum(['true', 'false']).optional(),
  serviceType: z.string().trim().max(80).optional(),
  triggerType: z.enum(['days', 'mileage']).optional(),
  userId: z.string().uuid().optional(),
  sort: z.enum(['createdAt', 'serviceType']).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

// GET /admin/reminders — paginated cross-account list + breakdowns.
adminRouter.get(
  '/reminders',
  validate({ query: remindersQuery }),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 25);
    const sort = (req.query.sort as string) ?? 'createdAt';
    const order = (req.query.order as 'asc' | 'desc') ?? 'desc';

    const where: Prisma.ReminderWhereInput = {
      ...(req.query.isDone !== undefined ? { isDone: req.query.isDone === 'true' } : {}),
      ...(req.query.serviceType ? { serviceType: req.query.serviceType as string } : {}),
      ...(req.query.triggerType ? { triggerType: req.query.triggerType as 'days' | 'mileage' } : {}),
      ...(req.query.userId ? { userId: req.query.userId as string } : {}),
    };

    const [total, rows, byServiceType, byTriggerType, doneCount, allCount] = await Promise.all([
      prisma.reminder.count({ where }),
      prisma.reminder.findMany({
        where,
        orderBy: { [sort]: order },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          serviceType: true,
          triggerType: true,
          triggerValue: true,
          notes: true,
          preferredServiceProvider: true,
          isDone: true,
          createdAt: true,
          vehicle: { select: { id: true, make: true, model: true, licensePlate: true } },
          user: { select: { id: true, phoneNumber: true, displayName: true } },
        },
      }),
      prisma.reminder.groupBy({ by: ['serviceType'], _count: { _all: true } }),
      prisma.reminder.groupBy({ by: ['triggerType'], _count: { _all: true } }),
      prisma.reminder.count({ where: { isDone: true } }),
      prisma.reminder.count(),
    ]);

    res.json({
      reminders: rows.map(({ user, ...rest }) => ({ ...rest, owner: user })),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      breakdowns: {
        byServiceType: byServiceType
          .map((r) => ({ key: r.serviceType, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
        byTriggerType: byTriggerType.map((r) => ({ key: r.triggerType, count: r._count._all })),
        completionRate: allCount > 0 ? doneCount / allCount : 0,
        done: doneCount,
        totalReminders: allCount,
      },
    });
  }),
);

// ── Documents (metadata & expiry only — no file contents, no licence PII) ─────
// GET /admin/documents — aggregate counts and expiry windows across all accounts.
adminRouter.get(
  '/documents',
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const plusDays = (n: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() + n);
      return d;
    };
    const in30 = plusDays(30);
    const in60 = plusDays(60);
    const in90 = plusDays(90);

    const [byType, total, withExpiry, expired, exp30, exp60, exp90, usersWith, licences, licExpired, licExp90] =
      await Promise.all([
        prisma.document.groupBy({ by: ['documentType'], _count: { _all: true } }),
        prisma.document.count(),
        prisma.document.count({ where: { expiryDate: { not: null } } }),
        prisma.document.count({ where: { expiryDate: { lt: now } } }),
        prisma.document.count({ where: { expiryDate: { gte: now, lte: in30 } } }),
        prisma.document.count({ where: { expiryDate: { gt: in30, lte: in60 } } }),
        prisma.document.count({ where: { expiryDate: { gt: in60, lte: in90 } } }),
        prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(DISTINCT "userId")::bigint AS count FROM documents`,
        prisma.driverLicense.count(),
        prisma.driverLicense.count({ where: { expiryDate: { lt: now } } }),
        prisma.driverLicense.count({ where: { expiryDate: { gte: now, lte: in90 } } }),
      ]);

    res.json({
      total,
      byType: byType
        .map((r) => ({ key: r.documentType, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      expiry: {
        expired,
        in30: exp30,
        in60: exp60,
        in90: exp90,
        withExpiry,
        noExpiry: total - withExpiry,
      },
      coverage: { usersWithDocuments: toNumber(usersWith[0]?.count ?? 0n) },
      driverLicences: { total: licences, expired: licExpired, expiringWithin90: licExp90 },
    });
  }),
);

// ── Single records (cross-account) ───────────────────────────────────────────
// GET /admin/fuel-records/:id — one fill-up with owner + vehicle.
adminRouter.get(
  '/fuel-records/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const record = await prisma.fuelRecord.findUnique({
      where: { id: req.params.id },
      include: {
        vehicle: { select: { id: true, make: true, model: true, licensePlate: true } },
        user: { select: { id: true, phoneNumber: true, displayName: true } },
      },
    });
    if (!record) throw ApiError.notFound('Fuel record not found');
    const { user, ...rest } = record;
    res.json({ record: { ...rest, owner: user } });
  }),
);

// GET /admin/service-records/:id — one job with owner + vehicle. Internal disk
// path (attachmentPath) is stripped; the client-facing attachmentUrl is kept.
adminRouter.get(
  '/service-records/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const record = await prisma.serviceRecord.findUnique({
      where: { id: req.params.id },
      include: {
        vehicle: { select: { id: true, make: true, model: true, licensePlate: true } },
        user: { select: { id: true, phoneNumber: true, displayName: true } },
      },
    });
    if (!record) throw ApiError.notFound('Service record not found');
    const { user, attachmentPath, ...rest } = record;
    void attachmentPath;
    res.json({ record: { ...rest, owner: user } });
  }),
);

// ── Trackers (cross-account maintenance items) ───────────────────────────────
// Oil-type analytics are deferred (the field isn't persisted server-side yet);
// this exposes only what's stored: name + last/next service date & mileage, plus
// a computed `overdue` flag (past next date, or next mileage reached).
const trackersQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  q: z.string().trim().max(80).optional(),
  userId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  sort: z.enum(['createdAt', 'name']).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

adminRouter.get(
  '/trackers',
  validate({ query: trackersQuery }),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 25);
    const q = (req.query.q as string | undefined)?.trim();
    const sort = (req.query.sort as string) ?? 'createdAt';
    const order = (req.query.order as 'asc' | 'desc') ?? 'desc';

    const where: Prisma.TrackerItemWhereInput = {
      ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
      ...(req.query.vehicleId ? { vehicleId: req.query.vehicleId as string } : {}),
      ...(req.query.userId ? { vehicle: { userId: req.query.userId as string } } : {}),
    };

    const [total, rows, byName, overdueRow] = await Promise.all([
      prisma.trackerItem.count({ where }),
      prisma.trackerItem.findMany({
        where,
        orderBy: { [sort]: order },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          lastServiceDate: true,
          lastServiceMileage: true,
          nextServiceDate: true,
          nextServiceMileage: true,
          vehicle: {
            select: {
              id: true,
              make: true,
              model: true,
              licensePlate: true,
              currentMileage: true,
              user: { select: { id: true, phoneNumber: true, displayName: true } },
            },
          },
        },
      }),
      prisma.trackerItem.groupBy({
        by: ['name'],
        _count: { _all: true },
        orderBy: { _count: { name: 'desc' } },
        take: 12,
      }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM tracker_items t JOIN vehicles v ON v.id = t."vehicleId"
        WHERE (t."nextServiceDate" IS NOT NULL AND t."nextServiceDate" < now())
           OR (t."nextServiceMileage" IS NOT NULL AND t."nextServiceMileage" <= v."currentMileage")
      `,
    ]);

    const now = Date.now();
    const trackers = rows.map(({ vehicle, ...t }) => {
      const { user, ...veh } = vehicle;
      const overdueDate = t.nextServiceDate ? new Date(t.nextServiceDate).getTime() < now : false;
      const overdueMileage =
        t.nextServiceMileage != null && t.nextServiceMileage <= vehicle.currentMileage;
      return { ...t, vehicle: veh, owner: user, overdue: overdueDate || overdueMileage };
    });

    res.json({
      trackers,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      breakdowns: {
        byName: byName.map((r) => ({ key: r.name, count: r._count._all })),
        overdue: toNumber(overdueRow[0]?.count ?? 0n),
      },
    });
  }),
);
