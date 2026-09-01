import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { corsOrigins, env } from './env';
import { apiRouter } from './routes';
import { openApiSpec } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { rateLimit } from './middleware/rateLimit';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Coarse global limiter — a backstop against a single client flooding the
  // API. Generous enough not to affect normal app/sync/dashboard usage.
  // Skipped under NODE_ENV=test so the suite isn't throttled.
  if (env.NODE_ENV !== 'test') {
    app.use(rateLimit({ windowMs: 60_000, max: 600 }));
  }
  if (env.NODE_ENV !== 'test') app.use(morgan('dev'));

  // Liveness probe (also available at /api/health).
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Interactive API docs (Swagger UI) + raw spec. Exposed only outside
  // production — publishing the full API surface publicly hands an attacker a
  // map of every endpoint. Set NODE_ENV=production to disable, or front it with
  // auth if you need hosted docs in prod.
  if (env.NODE_ENV !== 'production') {
    // helmet's default CSP blocks Swagger UI's inline styles/scripts, so disable
    // it just for the docs subtree.
    app.use('/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(openApiSpec, {
      customSiteTitle: 'Auto Pal API',
      swaggerOptions: { persistAuthorization: true },
    }));
    app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  }

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
