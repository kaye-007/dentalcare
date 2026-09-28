import { ConfigService } from '@nestjs/config';
import { DatabaseService } from './database.service';

/**
 * The boot check that the tenant role cannot bypass row-level security.
 *
 * It used to wave a failed check through. In production a check that could
 * not run is now a refusal to start: an isolation guarantee nobody could
 * verify is not one to serve clinics on.
 */

function service(env: Record<string, string>, role: () => Promise<unknown>) {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const db = new DatabaseService(config);
  // RUNTIME=workers creates no pools; the one query is stubbed.
  jest
    .spyOn(db as unknown as { lease: () => Promise<unknown> }, 'lease')
    .mockImplementation(role);
  return db;
}

const BASE = {
  RUNTIME: 'workers',
  DATABASE_URL: 'postgres://owner@db/x',
  APP_DATABASE_URL: 'postgres://app_user@db/x',
};
const PROD = { ...BASE, NODE_ENV: 'production' };
const DEV = { ...BASE, NODE_ENV: 'development' };

const restricted = async () => ({ rows: [{ rolsuper: false, rolbypassrls: false }] });
const superuser = async () => ({ rows: [{ rolsuper: true, rolbypassrls: false }] });
const unreachable = async () => {
  throw new Error('connection refused');
};
const noRow = async () => ({ rows: [] });

describe('the tenant role check at boot', () => {
  it('starts when the role is restricted', async () => {
    await expect(service(PROD, restricted).onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses to start in production on a superuser', async () => {
    await expect(service(PROD, superuser).onModuleInit()).rejects.toThrow(/SUPERUSER/);
  });

  it('refuses to start in production when the check cannot run', async () => {
    await expect(service(PROD, unreachable).onModuleInit()).rejects.toThrow(
      /Could not verify.*connection refused/,
    );
  });

  it('refuses to start in production when the role is not found', async () => {
    await expect(service(PROD, noRow).onModuleInit()).rejects.toThrow(/not found/);
  });

  it('only warns in development, so a database still starting is not a crash loop', async () => {
    await expect(service(DEV, unreachable).onModuleInit()).resolves.toBeUndefined();
    await expect(service(DEV, superuser).onModuleInit()).resolves.toBeUndefined();
  });
});
