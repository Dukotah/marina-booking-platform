import { defineConfig } from 'vitest/config';

/**
 * The API tests are LIVE integration suites that all hit the same seeded Neon tenant
 * through a shared module-singleton Prisma client (`adminPrisma`). Running files in
 * parallel let one file's afterAll `$disconnect()` tear the pool out from under
 * another mid-run, and also risks exhausting Neon's connection limit. Run them
 * sequentially — correctness over a few seconds of wall-clock.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
