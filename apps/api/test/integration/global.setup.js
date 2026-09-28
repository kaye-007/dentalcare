/**
 * Runs once, before any integration suite, and refuses the whole run when no
 * test database is named: one clear message instead of thirty-six failed
 * suites, and not a single query against the wrong database.
 */
const path = require('path');
const { resolveTestDatabase } = require('../../scripts/lib/test-database');

module.exports = async () => {
  const exported = { ...process.env };
  const { parsed } = require('dotenv').config({
    path: path.resolve(__dirname, '../../../../.env'),
    processEnv: {},
  });
  const target = resolveTestDatabase(exported, parsed ?? {});
  const { host, pathname } = new URL(target.databaseUrl);
  console.log(`\nIntegration database: ${host}${pathname} (from ${target.source})\n`);
};
