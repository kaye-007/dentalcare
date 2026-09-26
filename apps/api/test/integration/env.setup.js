/**
 * Load the repository .env before the integration suite reads process.env.
 *
 * Without this, `npm run test:integration` on a developer machine failed four
 * suites at import — tenant-isolation, role, privileges and double-booking,
 * which are precisely the ones that prove the isolation model. Jest reports
 * that as "Test suite failed to run", which reads like a flake rather than a
 * missing variable, and the four suites everyone most wants green were the
 * four nobody could run without exporting DATABASE_URL by hand first.
 *
 * CI is unaffected on purpose. It sets both URLs in the job environment and
 * ships no .env, and dotenv never overwrites a variable that is already set —
 * so an explicitly configured environment still wins, and a missing .env is
 * silently fine.
 */
const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../../../../.env'),
});

/**
 * MFA is required by default, which would put every suite's administrator
 * through enrollment before its first assertion. The suites that are not about
 * MFA run with it optional — an enrolled user is still challenged — and
 * api-mfa.itest.ts boots its own application with it required.
 */
process.env.MFA_ENFORCEMENT ??= 'optional';
