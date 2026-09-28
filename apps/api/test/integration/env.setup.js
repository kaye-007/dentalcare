/**
 * The environment of every integration test file.
 *
 * The repository .env is read, because the suites need its secrets and
 * settings, and a missing variable used to fail the four isolation suites at
 * import with an error that read like a flake. dotenv never overwrites a
 * variable that is already set, so an explicitly configured run still wins.
 *
 * Which DATABASE is not taken from .env, though: its DATABASE_URL is the
 * developer's own database. scripts/lib/test-database.js decides, and
 * global.setup.js has already refused the run if nothing suitable is named.
 */
const path = require('path');
const { resolveTestDatabase } = require('../../scripts/lib/test-database');

const exported = { ...process.env };
const { parsed } = require('dotenv').config({
  path: path.resolve(__dirname, '../../../../.env'),
});

const target = resolveTestDatabase(exported, parsed ?? {});
process.env.DATABASE_URL = target.databaseUrl;
process.env.APP_DATABASE_URL = target.appDatabaseUrl;

/**
 * MFA is required by default, which would put every suite's administrator
 * through enrollment before its first assertion. The suites that are not about
 * MFA run with it optional — an enrolled user is still challenged — and
 * api-mfa.itest.ts boots its own application with it required.
 */
process.env.MFA_ENFORCEMENT ??= 'optional';
