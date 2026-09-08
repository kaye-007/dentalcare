/** Unit + regression tests for the API. No database required. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // scripts/ carries the production guard that migrate:reset depends on to
  // decide whether it may drop a schema. Scoping jest to src/ alone is what
  // let its tests be deleted unnoticed.
  //
  // Repo-root scripts/ too: dev-setup owns the subdomain rules and the .env
  // rewrite, both of which are real logic that runs against a developer's
  // machine and neither of which tsc can check.
  //
  // And packages/shared: the contracts both planes depend on are tested by
  // the suite that has always tested them, rather than gaining a second
  // runner and a second place to look when one fails.
  roots: [
    '<rootDir>/src',
    '<rootDir>/scripts',
    '<rootDir>/../../scripts',
    '<rootDir>/../../packages/shared/src',
  ],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // Mirrors compilerOptions.paths so specs resolve @/ the same way tsc does.
    '^@/(.*)$': '<rootDir>/src/$1',
    // @dentalcare/shared resolves to its SOURCE here, not to dist. A suite
    // that went green against a stale build would be worse than no suite.
    '^@dentalcare/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  collectCoverageFrom: ['src/**/*.ts'],
};
