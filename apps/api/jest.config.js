/** Unit + regression tests for the API. No database required. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // scripts/ carries the production guard that migrate:reset depends on to
  // decide whether it may drop a schema. Scoping jest to src/ alone is what
  // let its tests be deleted unnoticed.
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts'],
};
