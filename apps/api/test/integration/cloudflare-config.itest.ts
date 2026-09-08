import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * What can be checked about the Cloudflare deployment without deploying it.
 *
 * Which is less than it looks. `wrangler deploy --dry-run` proves the Worker
 * bundles and that every binding resolves — it does not prove the Worker
 * serves a request, and this deployment has never served one. Five separate
 * failures in DEPLOYMENT.md all compiled, passed a dry run, and then threw on
 * the first real request.
 *
 * So these tests deliberately assert only the things that ARE mechanically
 * checkable from the configuration, and the file says plainly which of the
 * risks they do not cover. The rest is a staging checklist, not a test.
 */

const REPO = path.resolve(__dirname, '../../../..');

function wrangler(app: string): string {
  return fs.readFileSync(path.join(REPO, 'apps', app, 'wrangler.jsonc'), 'utf8');
}

/** jsonc — strip comments before parsing. */
function parseJsonc(source: string): Record<string, unknown> {
  const stripped = source
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

describe('the API Worker', () => {
  const source = wrangler('api');
  const config = parseJsonc(source) as {
    hyperdrive?: { binding: string; id: string; localConnectionString: string }[];
    vars?: Record<string, string>;
  };

  /**
   * TWO configs, never one. The tenant plane connects as app_user, which is
   * NOBYPASSRLS; the platform plane connects with the privileged role and
   * bypasses RLS by design. Pointing both bindings at one Hyperdrive config
   * would mean every clinic reads every other clinic's records — the same
   * failure the whole isolation model exists to prevent, introduced in a
   * dashboard rather than in code.
   */
  it('declares two distinct Hyperdrive bindings', () => {
    const bindings = config.hyperdrive ?? [];

    expect(bindings.map((b) => b.binding).sort()).toEqual([
      'HYPERDRIVE_ADMIN',
      'HYPERDRIVE_APP',
    ]);
    expect(new Set(bindings.map((b) => b.id)).size).toBe(2);
  });

  /**
   * The ids are placeholders and must stay placeholders in the repository.
   * A real id here would be a live account resource committed to git; an
   * invented one would be worse, because the deploy would fail in a way that
   * looks like a Cloudflare problem.
   */
  it('keeps the Hyperdrive ids as placeholders, not invented values', () => {
    for (const binding of config.hyperdrive ?? []) {
      expect(binding.id).toMatch(/^REPLACE_WITH_/);
    }
  });

  /**
   * Hyperdrive's result cache is keyed on the query, not on the transaction
   * that set app.current_tenant_id. A cached row from one clinic could be
   * served to another. Caching lives on the CONFIG, not on the binding, so it
   * cannot be asserted from this file — only the instruction to disable it
   * can be, and losing that instruction is how the next person creates a
   * cached config.
   */
  it('still documents --caching-disabled for both configs', () => {
    const occurrences = source.split('--caching-disabled').length - 1;

    expect(occurrences).toBe(2);
  });

  /**
   * Supabase's transaction-mode pooler on 6543 does not hold the session
   * state that `set_config('app.current_tenant_id', ..., true)` needs. Using
   * it would break tenant scoping in a way that looks intermittent.
   */
  it('points at the direct database port, not the transaction pooler', () => {
    for (const binding of config.hyperdrive ?? []) {
      expect(binding.localConnectionString).toContain(':5432/');
      expect(binding.localConnectionString).not.toContain(':6543');
    }
  });

  /**
   * 6543 appears in this file exactly once, inside the comment warning
   * against it. The warning is the only part that can survive into a
   * production config, since the ids themselves are created elsewhere.
   */
  it('still warns against the transaction pooler', () => {
    const mentions = source.split('6543').length - 1;

    expect(mentions).toBe(1);
    expect(source).toMatch(/not the 6543 pooler/);
  });

  /** The two planes must connect as different roles, locally as in production. */
  it('uses app_user for the tenant plane and the owner for the platform plane', () => {
    const app = (config.hyperdrive ?? []).find((b) => b.binding === 'HYPERDRIVE_APP');
    const admin = (config.hyperdrive ?? []).find((b) => b.binding === 'HYPERDRIVE_ADMIN');

    expect(app?.localConnectionString).toContain('app_user');
    expect(admin?.localConnectionString).not.toContain('app_user');
  });

  /**
   * NODE_ENV=production is what hard-disables the X-Tenant-Subdomain
   * override in TenantMiddleware. Without it the header would be honoured
   * whenever ALLOW_TENANT_HEADER happened to be set, and a client could name
   * whichever clinic it liked.
   */
  it('runs as production, which disables the tenant header override', () => {
    expect(config.vars?.NODE_ENV).toBe('production');
  });

  /** And the flag is not set here either — two independent reasons to refuse. */
  it('does not set ALLOW_TENANT_HEADER', () => {
    expect(config.vars).not.toHaveProperty('ALLOW_TENANT_HEADER');
    expect(source).not.toMatch(/"ALLOW_TENANT_HEADER"\s*:/);
  });

  it('sets RUNTIME=workers, which switches the database layer', () => {
    expect(config.vars?.RUNTIME).toBe('workers');
  });

  /**
   * Secrets belong in `wrangler secret put`, never in vars — this file is in
   * git.
   */
  it('carries no secret in its vars', () => {
    const vars = config.vars ?? {};
    for (const name of Object.keys(vars)) {
      expect(name).not.toMatch(/SECRET|PASSWORD|_KEY$/);
    }
  });
});

describe('the SPA Workers', () => {
  /**
   * Both SPAs proxy /api through a service binding so the request keeps the
   * clinic subdomain on its Host header all the way to TenantMiddleware.
   * Calling the API host directly would arrive with the wrong host and no
   * clinic could be resolved — and in production the header override that
   * would paper over it is disabled.
   */
  it.each([['tenant-web'], ['admin-web']])(
    '%s binds to the API Worker rather than calling it over the internet',
    (app) => {
      const config = parseJsonc(wrangler(app)) as {
        services?: { binding: string; service: string }[];
      };

      expect(config.services).toEqual([{ binding: 'API', service: 'dentalcare-api' }]);
    },
  );

  it('routes clinics on a wildcard subdomain and the console on its own host', () => {
    const tenant = parseJsonc(wrangler('tenant-web')) as {
      routes?: { pattern: string }[];
    };
    const admin = parseJsonc(wrangler('admin-web')) as {
      routes?: { pattern: string }[];
    };

    expect(tenant.routes?.[0].pattern).toMatch(/^\*\./);
    expect(admin.routes?.[0].pattern).not.toMatch(/^\*/);
  });
});
