import { createHmac } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/core/database/database.service';
import { RequestContextService } from '@/core/request-context/request-context';

/**
 * Failed sign-ins, counted where every process sees them (0025).
 *
 * The in-memory @Throttle on the login routes still runs, and on a single
 * container it is a fine first brake. On Workers each isolate counts for
 * itself, so it is not a limit at all. This one is: the database counts,
 * whichever isolate or replica the request reached.
 *
 * Two counters per attempt:
 *
 *   the account   10 failures in 15 minutes locks that address at that
 *                 clinic (or on the console) for 15 minutes, whether or not
 *                 an account exists there, so a lock says nothing about who
 *                 has one. A successful sign-in clears it.
 *   the address   100 failures in 15 minutes from one IP locks that IP out of
 *                 every sign-in for 15 minutes: one source trying one
 *                 password against many accounts. Loopback is exempt; it is a
 *                 developer or a health check, never a clinic.
 *
 * Keys are HMACs, so the table never holds an email address or an IP.
 *
 * The IP is the request context's: CF-Connecting-IP behind Cloudflare, else
 * the proxy-aware req.ip. On a deployment that is not behind Cloudflare a
 * client can set that header itself, so there the address counter is only
 * as good as the proxy in front; the account counter does not depend on it.
 */

export const ACCOUNT_LIMIT = { failures: 10, windowMinutes: 15, lockMinutes: 15 };
export const ADDRESS_LIMIT = { failures: 100, windowMinutes: 15, lockMinutes: 15 };

export type SignInScope = 'clinic' | 'platform';

export interface SignInKeys {
  account: string;
  address: string | null;
}

/** A developer's machine or a health check, never a real client. */
export function isLoopback(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, '');
  return v4.startsWith('127.') || ip === '::1';
}

/**
 * The two counter keys for one sign-in attempt. `account` is whatever
 * identifies the account within its scope: "<tenantId>:<email>" for a
 * clinic, the email for the console. Email case is ignored, as sign-in
 * ignores it.
 */
export function signInKeys(
  secret: Buffer,
  scope: SignInScope,
  account: string,
  ip: string | null,
): SignInKeys {
  const mac = (s: string) => createHmac('sha256', secret).update(s).digest('hex');
  return {
    account: `${scope}:${mac(`account:${account.trim().toLowerCase()}`)}`,
    address: ip && !isLoopback(ip) ? `ip:${mac(`address:${ip}`)}` : null,
  };
}

/** The refusal for a locked account or address. */
export function signInLocked(until: Date, now = Date.now()): HttpException {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now) / 60_000));
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: 'sign_in_locked',
      message: `Too many failed sign-ins. Try again in ${minutes} minute${
        minutes === 1 ? '' : 's'
      }.`,
      retryAfterSeconds: minutes * 60,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** Which pool: a clinic signs in on the tenant plane, the console on its own. */
export type SignInPlane = 'app' | 'admin';

@Injectable()
export class AuthThrottleService {
  private readonly secret: Buffer;

  constructor(
    private readonly db: DatabaseService,
    private readonly request: RequestContextService,
    config: ConfigService,
  ) {
    this.secret = createHmac('sha256', config.get<string>('JWT_SECRET') ?? '')
      .update('dentalcare:auth-throttle:v1')
      .digest();
  }

  keys(scope: SignInScope, account: string): SignInKeys {
    return signInKeys(this.secret, scope, account, this.request.get()?.ip ?? null);
  }

  /** Refuses the attempt, before any password work, while a lock holds. */
  async assertOpen(plane: SignInPlane, keys: SignInKeys): Promise<void> {
    const { rows } = await this.run<{ until: Date | null }>(
      plane,
      'SELECT auth_throttle_locked_until($1::text[]) AS until',
      [[keys.account, keys.address].filter((k): k is string => k !== null)],
    );
    const until = rows[0]?.until;
    if (until) throw signInLocked(until);
  }

  /**
   * Counts one failed attempt. When it is the one that reaches a limit, the
   * refusal is thrown now, so the person learns it on this attempt rather
   * than the next.
   */
  async failed(plane: SignInPlane, keys: SignInKeys): Promise<void> {
    const count = async (key: string, limit: typeof ACCOUNT_LIMIT) =>
      (
        await this.run<{ until: Date | null }>(
          plane,
          'SELECT auth_throttle_fail($1, $2, $3, $4) AS until',
          [key, limit.failures, limit.windowMinutes, limit.lockMinutes],
        )
      ).rows[0]?.until ?? null;

    const locks = [await count(keys.account, ACCOUNT_LIMIT)];
    if (keys.address) locks.push(await count(keys.address, ADDRESS_LIMIT));
    const until = locks.filter((d): d is Date => d !== null).sort((a, b) => +b - +a)[0];
    if (until) throw signInLocked(until);
  }

  /** A successful sign-in forgets the account's failures (not the address's). */
  async succeeded(plane: SignInPlane, keys: SignInKeys): Promise<void> {
    await this.run(plane, 'SELECT auth_throttle_clear($1)', [keys.account]);
  }

  private run<T extends object>(plane: SignInPlane, sql: string, params: unknown[]) {
    return plane === 'admin'
      ? this.db.adminQuery<T & Record<string, unknown>>(sql, params)
      : this.db.query<T & Record<string, unknown>>(sql, params);
  }
}
