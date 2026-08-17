import { Router } from 'express';
import { authRouter } from './modules/auth';
import { profileRouter } from './modules/profile';
import { preferencesRouter } from './modules/preferences';
import { vehiclesRouter } from './modules/vehicles';
import { trackersRouter } from './modules/trackers';
import { fuelRouter } from './modules/fuel';
import { serviceRouter } from './modules/service';
import { remindersRouter } from './modules/reminders';
import { documentsRouter } from './modules/documents';
import { licenseRouter } from './modules/license';
import { backupRouter } from './modules/backup';
import { adminRouter } from './modules/admin';
import { bannersRouter, adminBannersRouter } from './modules/banners';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

apiRouter.use('/auth', authRouter);

// Cross-account admin endpoints (role: admin only).
apiRouter.use('/admin', adminRouter);
// Admin-managed promo banners pushed to the mobile dashboard strip.
apiRouter.use('/admin/banners', adminBannersRouter);
apiRouter.use('/banners', bannersRouter);
apiRouter.use('/profile', profileRouter);
apiRouter.use('/preferences', preferencesRouter);

// Vehicles + nested trackers.
apiRouter.use('/vehicles', vehiclesRouter);
apiRouter.use('/vehicles/:vehicleId/trackers', trackersRouter);

// Flat, vehicle-filtered record collections (?vehicleId=...).
apiRouter.use('/fuel-records', fuelRouter);
apiRouter.use('/service-records', serviceRouter);
apiRouter.use('/reminders', remindersRouter);

// User-scoped resources.
apiRouter.use('/documents', documentsRouter);
apiRouter.use('/driving-licence', licenseRouter);

// Backup / import / sync (these define their own full paths).
apiRouter.use('/', backupRouter);
