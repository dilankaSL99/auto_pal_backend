import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration tests hit a real Postgres and hash passwords with bcrypt
    // (cost 12, ~200ms each). Run the files serially and give each test room so
    // the suite is reliable rather than racing the shared DB under the default
    // 5s timeout.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
