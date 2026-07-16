import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // The DB-backed integration suites (db.test.ts, poller.integration,
    // friction/*.integration) share one Postgres and a GLOBAL job queue:
    // claimJob and the scheduler's lane history read across every tenant, so
    // parallel test files corrupt each other's state. Serialize files when a
    // real database is attached; keyless runs keep full parallelism.
    fileParallelism: !process.env['DATABASE_URL'],
  },
});
