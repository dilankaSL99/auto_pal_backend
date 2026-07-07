import 'dotenv/config';
import { z } from 'zod';

// Fail fast at boot if the environment is misconfigured, rather than crashing
// on the first request that needs a missing value.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default('*'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be set'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be set'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // Comma-separated Google OAuth client IDs accepted as the ID-token audience
  // (your app's iOS / Android / Web client IDs). Empty disables Google sign-in.
  GOOGLE_CLIENT_IDS: z.string().default(''),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    '❌ Invalid environment variables:\n',
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins =
  env.CORS_ORIGIN === '*'
    ? true
    : env.CORS_ORIGIN.split(',').map((s) => s.trim());

export const googleClientIds = env.GOOGLE_CLIENT_IDS
  ? env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
