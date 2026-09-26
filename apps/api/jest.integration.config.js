/**
 * Integration tests. These need a real PostgreSQL.
 *
 * Kept apart from jest.config.js on purpose: the unit suite must stay
 * runnable with nothing installed but node_modules, so that a failing test
 * there always means a broken behaviour and never a missing database. These
 * are the opposite — their whole value is that nothing is mocked.
 *
 *   DATABASE_URL       the privileged role. Migrations, and the fixtures that
 *                      set up a scenario across tenants.
 *   APP_DATABASE_URL   app_user. Every assertion about isolation connects as
 *                      THIS role; as the owner they would prove nothing,
 *                      because the owner is not subject to the policies.
 *
 * `.itest.ts`, not `.spec.ts`, so the two suites cannot pick up each other's
 * files by accident.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testRegex: '\\.itest\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Reads the repository .env before any suite imports test/integration/db.ts.
  // See that file: without it, the four suites that prove tenant isolation
  // threw at import on any machine that had not exported the URLs by hand.
  setupFiles: ['<rootDir>/test/integration/env.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Source, not dist — same reasoning as the unit config. These tests are
    // the ones that decide whether tenant isolation holds; running them
    // against a build from an hour ago would be the worst possible way to be
    // told it does.
    '^@dentalcare/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  // One database, shared. Parallel workers would race on the fixtures.
  maxWorkers: 1,
  // Booting a Nest application and opening pools is slower than a unit test,
  // and CI runners are slower still.
  testTimeout: 30_000,
};
