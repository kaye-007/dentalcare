import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * dev-setup runs against a developer's own machine and writes to their .env.
 * Two pieces of it carry real rules rather than glue, and neither is something
 * tsc can check:
 *
 *   - what makes a valid clinic subdomain. Subdomains become hostnames, and
 *     one accepted here but unroutable in production is a clinic that works
 *     locally and nowhere else.
 *   - the .env rewrite. It edits a file the developer owns and did not ask to
 *     have reformatted, so it must change one line and leave every comment,
 *     blank line and line ending exactly as it found them.
 */

const { validateSubdomain, writeEnvVar } = require('./dev-setup.js');

describe('validateSubdomain', () => {
  it.each(['avicena', 'a', 'a-b-c', 'clinic123', 'x'.repeat(32)])(
    'accepts "%s"',
    (value) => {
      expect(validateSubdomain(value)).toBeNull();
    },
  );

  it('accepts uppercase, which is lowercased before use', () => {
    expect(validateSubdomain('UPPER')).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['-lead', 'leading hyphen'],
    ['trail-', 'trailing hyphen'],
    ['has space', 'space'],
    ['under_score', 'underscore'],
    ['dot.dot', 'a dot is a second label, not a subdomain'],
    ['x'.repeat(33), 'too long'],
  ])('rejects "%s" (%s)', (value) => {
    expect(validateSubdomain(value)).toEqual(expect.any(String));
  });

  /**
   * TenantMiddleware refuses to read `www` as a clinic, and `api` and `admin`
   * are the two custom domains in wrangler.jsonc. A clinic on any of them
   * resolves through DEV_TENANT_SUBDOMAIN locally and is unreachable once
   * deployed — the worst kind of failure, because local development says yes.
   */
  it.each(['www', 'api', 'admin'])('rejects the reserved label "%s"', (value) => {
    expect(validateSubdomain(value)).toMatch(/reserved/);
  });
});

describe('writeEnvVar', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentalcare-env-'));
    envPath = path.join(dir, '.env');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Writes the file, applies the change, hands back the result verbatim. */
  function rewrite(contents: string): string {
    fs.writeFileSync(envPath, contents);
    writeEnvVar('DEV_TENANT_SUBDOMAIN', 'avicena', envPath);
    return fs.readFileSync(envPath, 'utf8');
  }

  it('replaces an existing value and touches nothing else', () => {
    const before = [
      '# a comment',
      'NODE_ENV=development',
      '',
      '# which clinic localhost is',
      'DEV_TENANT_SUBDOMAIN=demo',
      '',
      'JWT_SECRET=keep-me',
      '',
    ].join('\n');

    expect(rewrite(before)).toBe(
      before.replace('DEV_TENANT_SUBDOMAIN=demo', 'DEV_TENANT_SUBDOMAIN=avicena'),
    );
  });

  /**
   * A commented-out variable is rewritten in place rather than left alone
   * with a live copy appended: two lines naming the same variable is a config
   * whose meaning depends on which one dotenv reads last.
   */
  it('revives a commented-out variable rather than appending a duplicate', () => {
    const after = rewrite('# DEV_TENANT_SUBDOMAIN=demo\nPORT=3000\n');

    expect(after).toBe('DEV_TENANT_SUBDOMAIN=avicena\nPORT=3000\n');
    expect(after.match(/DEV_TENANT_SUBDOMAIN/g)).toHaveLength(1);
  });

  it('appends when the variable is absent', () => {
    expect(rewrite('PORT=3000\n')).toBe('PORT=3000\n\nDEV_TENANT_SUBDOMAIN=avicena');
  });

  it('preserves CRLF line endings', () => {
    const after = rewrite('PORT=3000\r\nDEV_TENANT_SUBDOMAIN=demo\r\n');

    expect(after).toBe('PORT=3000\r\nDEV_TENANT_SUBDOMAIN=avicena\r\n');
  });

  it('leaves a missing file alone rather than creating one', () => {
    const absent = path.join(dir, 'nope.env');

    writeEnvVar('DEV_TENANT_SUBDOMAIN', 'avicena', absent);

    expect(fs.existsSync(absent)).toBe(false);
  });
});
