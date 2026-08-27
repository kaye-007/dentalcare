/**
 * Static-asset Worker for the SPA.
 *
 * It exists for one reason: `/api/*` has to stay SAME-ORIGIN.
 *
 * The API resolves which clinic a request belongs to from the subdomain of
 * the Host header (see TenantMiddleware — the X-Tenant-Subdomain override is
 * hard-disabled in production, deliberately). If the browser called
 * api.dentalcare.com directly, every request would arrive with the wrong host
 * and no clinic could be resolved. Proxying through the SPA's own origin keeps
 * avicena.dentalcare.com on the request all the way to the tenant middleware,
 * and has the side benefit that no CORS preflight is ever needed and the
 * access token never leaves its origin.
 *
 * The hop is a service binding, so it is an internal call inside Cloudflare's
 * network rather than a second trip over the internet.
 */
interface Env {
  /** The built SPA in ./dist. */
  ASSETS: Fetcher;
  /** The DentalCare API Worker. */
  API: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return env.API.fetch(request);
    }
    // Reached only if run_worker_first ever widens; assets are otherwise
    // served before this Worker is invoked.
    return env.ASSETS.fetch(request);
  },
};
