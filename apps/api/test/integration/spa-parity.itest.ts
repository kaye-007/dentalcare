import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The two SPAs share four files byte for byte. This asserts they still do.
 *
 * ── Why assert rather than deduplicate ────────────────────────────────────
 *
 * The plan called for extracting these into a shared module. Each extraction
 * was tried against what it would actually cost, and each cost more than the
 * duplication:
 *
 *   worker/index.ts   is 14 lines of code under 16 lines of comment. Moving
 *                     it means the shared package — which the Nest API also
 *                     consumes — either takes a dependency on
 *                     @cloudflare/workers-types, or declares structural
 *                     stand-ins for Request and Response and loses the typing
 *                     at the one boundary that matters. Both to remove 14
 *                     lines.
 *
 *   tsconfig*.json    Three files per app. A shared base cannot carry
 *                     `include`, `outDir` or `tsBuildInfoFile`, because
 *                     relative paths in an extended config resolve against
 *                     the file that declares them — so every app would still
 *                     need those three, and the repository would gain three
 *                     base files to remove nothing. Nine files instead of six.
 *
 *   public/_headers   A single shared copy needs a build step to place it in
 *                     each app's public/. A copy step that silently fails is
 *                     precisely the failure mode this file exists to prevent:
 *                     an SPA shipped without its Content-Security-Policy.
 *
 * The risk being managed is drift — someone fixes one and not the other. A
 * test removes that risk completely, costs nothing to run, and names the file
 * and the difference when it fires. That is the whole benefit of extraction
 * without any of the machinery.
 *
 * If one of these ever SHOULD differ between the two apps, this test is the
 * place that decision gets recorded.
 */

const REPO = path.resolve(__dirname, '../../../..');
const TENANT = path.join(REPO, 'apps/tenant-web');
const ADMIN = path.join(REPO, 'apps/admin-web');

function read(app: string, relative: string): string {
  // Normalised, so a checkout with different line endings does not read as a
  // difference. Git is configured to convert these on Windows.
  return fs.readFileSync(path.join(app, relative), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The one recorded difference (0012): the clinic app may use the device
 * camera — patient photos, ID documents and clinical photos are taken at the
 * desk — so its Permissions-Policy allows `camera=(self)`. The console takes
 * no pictures and keeps `camera=()`. Nothing else in the file may differ.
 */
const CLINIC_CAMERA = 'Permissions-Policy: camera=(self),';
const NO_CAMERA = 'Permissions-Policy: camera=(),';

describe('the two SPAs stay in step', () => {
  it.each([
    ['worker/index.ts'],
    ['tsconfig.json'],
    ['tsconfig.node.json'],
    ['tsconfig.worker.json'],
  ])('%s is identical in both apps', (relative) => {
    expect(read(TENANT, relative)).toBe(read(ADMIN, relative));
  });

  it('public/_headers is identical in both apps but for the clinic app camera', () => {
    const tenant = read(TENANT, 'public/_headers');
    const admin = read(ADMIN, 'public/_headers');
    expect(tenant).toContain(CLINIC_CAMERA);
    expect(admin).toContain(NO_CAMERA);
    expect(tenant.replace(CLINIC_CAMERA, NO_CAMERA)).toBe(admin);
  });
});

describe('security headers survive in both apps', () => {
  /**
   * Named individually rather than compared as a blob, so that deleting one
   * directive from BOTH files — which the identity test above would happily
   * accept — still fails. These are the headers the audit verified on a live
   * response; losing one is not a formatting change.
   */
  const REQUIRED = [
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'X-Frame-Options: DENY',
    'Cross-Origin-Opener-Policy: same-origin',
    'Permissions-Policy:',
    'Content-Security-Policy:',
  ];

  it.each([
    ['tenant-web', TENANT],
    ['admin-web', ADMIN],
  ])('%s sends every required header', (_name, app) => {
    const headers = read(app, 'public/_headers');
    for (const directive of REQUIRED) {
      expect(headers).toContain(directive);
    }
  });

  /**
   * The CSP is the one that would be quietly weakened rather than removed.
   * These three directives are what stop an injected script from running and
   * an injected form from posting somewhere else.
   */
  it.each([
    ['tenant-web', TENANT],
    ['admin-web', ADMIN],
  ])('%s keeps the load-bearing CSP directives', (_name, app) => {
    const headers = read(app, 'public/_headers');
    const csp = headers.split('\n').find((l) => l.includes('Content-Security-Policy:'));

    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // 'unsafe-eval' in script-src would defeat the point of having a CSP.
    expect(csp).not.toContain('unsafe-eval');
  });

  /**
   * Vite fingerprints everything under /assets, so it can be cached forever.
   * index.html cannot: a clinic that caches it keeps running last week's
   * build after a deploy, including last week's bugs.
   */
  it.each([
    ['tenant-web', TENANT],
    ['admin-web', ADMIN],
  ])('%s does not let index.html be cached', (_name, app) => {
    const headers = read(app, 'public/_headers');

    expect(headers).toMatch(/\/index\.html\s*\n\s*Cache-Control: no-cache/);
    expect(headers).toMatch(
      /\/assets\/\*\s*\n\s*Cache-Control: public, max-age=\d+, immutable/,
    );
  });
});

describe('the SPA proxy worker', () => {
  /**
   * The reason this worker exists at all: /api must stay same-origin, because
   * the API reads the clinic from the Host header and the production override
   * is hard-disabled. A worker that stopped proxying would send every request
   * to an origin with no clinic in it.
   */
  it.each([
    ['tenant-web', TENANT],
    ['admin-web', ADMIN],
  ])('%s proxies /api to the API binding', (_name, app) => {
    const worker = read(app, 'worker/index.ts');

    expect(worker).toContain('env.API.fetch(request)');
    expect(worker).toMatch(/pathname\.startsWith\('\/api\/'\)/);
    expect(worker).toContain('env.ASSETS.fetch(request)');
  });
});
