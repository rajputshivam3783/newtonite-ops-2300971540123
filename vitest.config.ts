import { defineConfig } from 'vitest/config';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/opsdb_test';

export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false, // all files share one test database
    testTimeout: 20000,
    env: { DATABASE_URL: TEST_DB_URL, JWT_SECRET: 'test-secret' },
  },
});
