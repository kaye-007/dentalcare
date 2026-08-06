/* eslint-disable no-console */
/**
 * Shared production guard for the data scripts.
 *
 * Both seed-demo and reset-demo write credentials and destroy data. Run
 * against a live database either would be unrecoverable, so they refuse to
 * touch anything that is not obviously a local or explicitly-approved
 * development database.
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal'];

/**
 * @param {string} connectionString
 * @param {{ overrideVar?: string, action?: string }} [opts]
 */
function assertNotProduction(connectionString, opts = {}) {
  const overrideVar = opts.overrideVar || 'ALLOW_REMOTE_SEED';
  const action = opts.action || 'seed';

  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Refusing to ${action}: NODE_ENV=production.`);
  }

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string.');
  }

  const host = url.hostname;
  const dbName = url.pathname.replace(/^\//, '');

  if (/prod/i.test(dbName) || /prod/i.test(host)) {
    throw new Error(`Refusing to ${action}: "${host}/${dbName}" looks like production.`);
  }
  if (!LOCAL_HOSTS.includes(host) && process.env[overrideVar] !== 'yes') {
    throw new Error(
      `Refusing to ${action} a non-local database (${host}).\n` +
        `  If you really mean it, set ${overrideVar}=yes.`,
    );
  }

  return { host, dbName };
}

module.exports = { assertNotProduction, LOCAL_HOSTS };
