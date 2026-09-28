import { timingSafeEqual } from 'node:crypto';
import { STATE_TTL_SECONDS } from './oauth-state';

/**
 * Ties a Google sign-in to the browser that started it.
 *
 * The signed state stops anyone forging where a sign-in lands. It did not
 * stop login CSRF: an attacker signs in with their own Google account, stops
 * at the callback, and sends that callback URL to a receptionist. Her browser
 * finishes the attacker's sign-in, and she goes on working inside the
 * attacker's session, entering patients into an account the attacker reads.
 *
 * So the start also leaves a cookie holding the state's nonce, and the
 * callback refuses a state whose nonce this browser does not hold. A browser
 * that never started that sign-in has no such cookie.
 *
 * The start runs on the clinic's host (through the SPA) or the console's; the
 * callback on the API host. The cookie is therefore scoped to the parent
 * domain of the callback host, which those hosts share. It is HttpOnly (no
 * script reads it), SameSite=Lax (sent on the top-level GET back from Google,
 * never on a cross-site subrequest), lives as long as a state does, and is
 * cleared by the callback that uses it.
 */

export const BINDING_COOKIE = 'dc_oauth';

/** Both the start routes and the one callback live under this path. */
const BINDING_PATH = '/api/auth/google';

/**
 * The Domain attribute: the parent of the callback host (api.dentalcare.com
 * -> dentalcare.com), the host itself at an apex, and host-only for
 * localhost or an IP address. The start and the callback compute the same
 * value from configuration, and a start on a host outside that domain is
 * refused by the browser itself, which fails the sign-in closed.
 */
export function bindingDomain(callbackHost: string): string | undefined {
  const host = callbackHost.toLowerCase();
  if (!host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host))
    return undefined;
  const labels = host.split('.');
  return labels.length >= 3 ? labels.slice(1).join('.') : host;
}

interface CookieOpts {
  domain?: string;
  secure: boolean;
}

function attributes({ domain, secure }: CookieOpts): string {
  return [
    `Path=${BINDING_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    ...(domain ? [`Domain=${domain}`] : []),
  ].join('; ');
}

/** Set-Cookie for the start of a sign-in. */
export function bindingCookie(nonce: string, opts: CookieOpts): string {
  return `${BINDING_COOKIE}=${nonce}; Max-Age=${STATE_TTL_SECONDS}; ${attributes(opts)}`;
}

/** Set-Cookie that removes it, once the callback has used it. */
export function clearedBindingCookie(opts: CookieOpts): string {
  return `${BINDING_COOKIE}=; Max-Age=0; ${attributes(opts)}`;
}

/** Whether this request's cookies carry the nonce of the state it presents. */
export function boundToThisBrowser(
  cookieHeader: string | undefined,
  nonce: string,
): boolean {
  if (!cookieHeader || !nonce) return false;
  const value = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${BINDING_COOKIE}=`))
    ?.slice(BINDING_COOKIE.length + 1);
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(nonce);
  return a.length === b.length && timingSafeEqual(a, b);
}
