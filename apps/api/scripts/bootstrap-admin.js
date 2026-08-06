/* eslint-disable no-console */
/**
 * Create the first platform administrator on a real database.
 *
 * The demo seed deliberately refuses to run in production — it writes
 * documented credentials — which left no supported way to create the initial
 * superadmin on a live deployment. This is that way.
 *
 * Unlike the seed, this script IS allowed to run in production. It writes only
 * the one account you give it, never demo data, and never overwrites an
 * existing account unless you explicitly ask.
 *
 * Usage (as a one-off job on Render/Railway, or locally):
 *
 *   PLATFORM_ADMIN_EMAIL=you@company.com \
 *   PLATFORM_ADMIN_PASSWORD='a-long-random-password' \
 *   npm run bootstrap-admin
 *
 * To rotate an existing admin's password, add FORCE_RESET=yes.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD = 12;

function fail(message) {
  throw new Error(message);
}

function readInput() {
  const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || '';
  const fullName = (process.env.PLATFORM_ADMIN_NAME || 'Platform Administrator').trim();

  if (!email) fail('PLATFORM_ADMIN_EMAIL is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`"${email}" is not a valid email address.`);
  if (!password) fail('PLATFORM_ADMIN_PASSWORD is required.');

  // Checked before the length rule so a recognised password gets the specific
  // reason rather than a generic "too short".
  const PUBLISHED = ['Demo@2026!', 'Admin123!', 'Owner123!', 'Reception123!', 'changeme', 'password'];
  if (PUBLISHED.some((p) => password.toLowerCase() === p.toLowerCase())) {
    fail('That password is published in this repository. Choose a different one.');
  }

  if (password.length < MIN_PASSWORD) {
    fail(`PLATFORM_ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters (got ${password.length}).`);
  }

  return { email, password, fullName };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set.');
  }
  const { email, password, fullName } = readInput();
  const force = process.env.FORCE_RESET === 'yes';

  const url = new URL(process.env.DATABASE_URL);
  console.log(`\n  Target: ${url.hostname}/${url.pathname.replace(/^\//, '')}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, full_name FROM platform_admins WHERE lower(email) = lower($1)',
      [email],
    );

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    if (existing.rows[0]) {
      if (!force) {
        fail(
          `An administrator with the email ${email} already exists.\n` +
            '  Refusing to overwrite it. To rotate the password, set FORCE_RESET=yes.',
        );
      }
      await client.query(
        `UPDATE platform_admins
            SET password_hash = $2, full_name = $3, status = 'active', updated_at = now()
          WHERE id = $1`,
        [existing.rows[0].id, hash, fullName],
      );
      await client.query('COMMIT');
      console.log(`\n  Password rotated for ${email}.\n`);
      return;
    }

    const total = await client.query('SELECT count(*)::int AS c FROM platform_admins');
    await client.query(
      `INSERT INTO platform_admins (email, password_hash, full_name, status)
       VALUES ($1, $2, $3, 'active')`,
      [email, hash, fullName],
    );
    await client.query('COMMIT');

    console.log(`\n  Created platform administrator: ${fullName} <${email}>`);
    if (total.rows[0].c === 0) {
      console.log('  This is the first administrator — sign in to the platform console to');
      console.log('  create your first clinic.\n');
    } else {
      console.log(`  (${total.rows[0].c + 1} administrators now exist.)\n`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/** pg connection failures often carry an empty .message — surface the code. */
function describe(err) {
  if (err && err.message) return err.message;
  if (err && (err.code || err.errno)) {
    const code = err.code || err.errno;
    if (code === 'ECONNREFUSED') {
      return 'could not reach the database (connection refused). Is Postgres running, and is DATABASE_URL correct?';
    }
    return `database error ${code}`;
  }
  return String(err);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n  Bootstrap failed: ${describe(err)}\n`);
    process.exit(1);
  });
}

module.exports = { readInput };
