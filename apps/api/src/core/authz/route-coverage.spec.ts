import 'reflect-metadata';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { PERMISSIONS_METADATA_KEY } from './permissions.decorator';
import { PERMISSIONS, Permission } from '@dentalcare/shared';

/**
 * Structural guard against the hole this pass closed.
 *
 * `PermissionsGuard` allows any route that declares no permissions — a
 * deliberate choice, but it makes forgetting a decorator fail OPEN. That is
 * exactly what had happened to the finance plane: eight of its nine routes
 * declared nothing, so invoice creation, payment recording and the finance
 * summary were reachable by any signed-in clinic user.
 *
 * This walks every controller under src/modules/clinic and fails the build if a route
 * handler resolves to no permission at all. A route that genuinely needs none
 * goes in ALLOWLIST below, with its reason, so the exception is a decision
 * somebody made rather than a decorator somebody dropped.
 *
 * It also checks the quieter failure: a controller can declare permissions and
 * still not enforce them, because PermissionsGuard is applied per controller
 * rather than globally. RemindersController was in exactly that state — one
 * @UseGuards(JwtAuthGuard) and no PermissionsGuard — so any decorator added to
 * it would have read as protection while enforcing nothing. Declared-but-
 * unenforced is worse than undeclared: it looks safe.
 */

/** `Controller.handler` entries that legitimately declare no permission. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'AuthController.login': 'Unauthenticated by definition — issues the token.',
  'AuthController.refresh': 'Presents a refresh token, not an access role.',
  'AuthController.me':
    'Returns the caller their own identity and permission list. Holding any valid token is the whole requirement.',
  'AuthController.changePassword':
    'Changes the caller OWN password, re-verifying the current one. Gating it on a permission would let an admin lock a user out of their own credentials.',
  'AuthController.logout':
    'Presents a refresh token, and ends only the session that token belongs to.',
  'AuthController.verifyMfa':
    'The second step of a sign-in. Presents a challenge token, not an access role.',
  'AuthController.beginEnrollment':
    'Enrollment during a sign-in that requires MFA. Presents a challenge token, not an access role.',
  'AuthController.confirmEnrollment':
    'Enrollment during a sign-in that requires MFA. Presents a challenge token, not an access role.',
  'AuthController.mfaStatus': "The caller's OWN second-factor state.",
  'AuthController.setupTotp':
    "Enrolls the caller's OWN device. Every role must be able to protect its own account.",
  'AuthController.confirmTotp':
    "Enrolls the caller's OWN device. Every role must be able to protect its own account.",
  'AuthController.regenerateRecoveryCodes':
    "The caller's OWN recovery codes, proven with a current code.",
  'AuthController.disableMfa':
    "The caller's OWN factor, proven with password and code, and refused where MFA is required.",
  'AuthController.sessions': "The caller's OWN signed-in devices.",
  'AuthController.revokeOtherSessions': "Ends the caller's OWN other sessions.",
  'AuthController.revokeSession':
    "Ends one of the caller's OWN sessions; ownership is checked.",
  'ReminderDeliveryController.twilio':
    'Called by the SMS provider, not a signed-in user. Authenticated by the provider signature over the full URL and body; it can only move the reminder that URL names, inside the clinic it names, under that clinic’s RLS.',
};

const CLINIC_DIR = join(__dirname, '..', '..', 'modules', 'clinic');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

interface Route {
  key: string;
  controller: string;
  permissions: Permission[] | undefined;
  /** Guard class names in force on this route: controller-level + method. */
  guards: string[];
}

function guardNames(target: object): string[] {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
  return guards.map((g) =>
    typeof g === 'function' ? g.name : (g?.constructor?.name ?? String(g)),
  );
}

function discoverRoutes(): Route[] {
  const routes: Route[] = [];

  for (const file of sourceFiles(CLINIC_DIR)) {
    const mod = require(file) as Record<string, unknown>;

    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      // @Controller() sets PATH_METADATA; @Module() does not.
      if (Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;

      const cls = exported as new (...args: never[]) => unknown;
      const classPerms = Reflect.getMetadata(PERMISSIONS_METADATA_KEY, cls) as
        Permission[] | undefined;
      const classGuards = guardNames(cls);

      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name === 'constructor') continue;
        const handler = (cls.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        // @Get/@Post/... set METHOD_METADATA on the handler.
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;

        const own = Reflect.getMetadata(PERMISSIONS_METADATA_KEY, handler) as
          Permission[] | undefined;

        routes.push({
          key: `${cls.name}.${name}`,
          controller: cls.name,
          // Method-level overrides class-level — the same precedence
          // PermissionsGuard applies via getAllAndOverride.
          permissions: own ?? classPerms,
          guards: [...classGuards, ...guardNames(handler)],
        });
      }
    }
  }

  return routes;
}

describe('tenant route permission coverage', () => {
  const routes = discoverRoutes();

  it('finds the tenant controllers at all', () => {
    // A refactor that moves or renames the tenant tree must not turn this
    // suite into a vacuous pass.
    expect(routes.length).toBeGreaterThan(60);
  });

  it('declares a permission on every tenant route', () => {
    const uncovered = routes
      .filter((r) => !r.permissions || r.permissions.length === 0)
      .map((r) => r.key)
      .filter((key) => !(key in ALLOWLIST))
      .sort();

    expect(uncovered).toEqual([]);
  });

  it('declares only real permissions', () => {
    const known = new Set<string>(PERMISSIONS);
    const bogus = routes
      .flatMap((r) => (r.permissions ?? []).map((p) => `${r.key} -> ${p}`))
      .filter((entry) => !known.has(entry.split(' -> ')[1]!))
      .sort();

    expect(bogus).toEqual([]);
  });

  it('actually enforces what it declares', () => {
    // A declared permission is inert unless PermissionsGuard is on the route,
    // and PermissionsGuard is inert unless JwtAuthGuard has already populated
    // req.user. Both must be present wherever a permission is required.
    const unenforced = routes
      .filter((r) => !(r.key in ALLOWLIST))
      .filter(
        (r) =>
          !r.guards.includes('PermissionsGuard') || !r.guards.includes('JwtAuthGuard'),
      )
      .map((r) => `${r.key} [guards: ${r.guards.join(', ') || 'none'}]`)
      .sort();

    expect(unenforced).toEqual([]);
  });

  it('keeps the allowlist honest', () => {
    // An allowlisted route that has since been given a permission, or removed
    // entirely, should drop out of the list rather than sit there implying an
    // exemption that no longer exists.
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const stale = Object.keys(ALLOWLIST)
      .filter((key) => {
        const route = byKey.get(key);
        return !route || (route.permissions && route.permissions.length > 0);
      })
      .sort();

    expect(stale).toEqual([]);
  });
});
