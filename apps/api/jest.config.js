/** Unit + regression tests for the API. No database required. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // scripts/ carries the production guard that migrate:reset depends on to
  // decide whether it may drop a schema. Scoping jest to src/ alone is what
  // let its tests be deleted unnoticed.
  // Repo-root scripts/ too: dev-setup owns the subdomain rules and the .env
  // rewrite, both of which are real logic that runs against a developer's
  // machine and neither of which tsc can check.
  roots: ['<rootDir>/src', '<rootDir>/scripts', '<rootDir>/../../scripts'],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Mirrors compilerOptions.paths so specs resolve @/ the same way tsc does.
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  collectCoverageFrom: ['src/**/*.ts'],
};
