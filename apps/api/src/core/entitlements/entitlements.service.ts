import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Global,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PoolClient } from 'pg';
import {
  FEATURES,
  isFeatureKey,
  resolveFeatures,
  type FeatureKey,
  type ResolvedFeature,
} from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';

/**
 * What this clinic may use right now (0013).
 *
 * Three inputs, read in the caller's tenant transaction when there is one so a
 * decision and the write it permits see the same rows:
 *
 *   the plan's entitlements       plan_entitlements, through tenants.plan_id
 *   live overrides                tenant_entitlement_overrides, not revoked
 *                                 and not expired
 *   the clinic's own switches     tenant_feature_settings
 *
 * The precedence between them is `resolveFeatures` in @dentalcare/shared, a
 * pure function with a truth table under test.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  /** Resolve every feature inside an existing tenant transaction. */
  async resolveWithin(client: PoolClient): Promise<Record<FeatureKey, ResolvedFeature>> {
    const toBool = (rows: { feature_key: string; value: unknown }[]) => {
      const out: Partial<Record<FeatureKey, boolean>> = {};
      for (const r of rows) {
        // Only booleans mean anything today. A limit (a number) stored against
        // a boolean feature is ignored rather than coerced into "on".
        if (isFeatureKey(r.feature_key) && typeof r.value === 'boolean') out[r.feature_key] = r.value;
      }
      return out;
    };

    const plan = await client.query<{ feature_key: string; value: unknown }>(
      `SELECT pe.feature_key, pe.value
         FROM tenants t
         JOIN plan_entitlements pe ON pe.plan_id = t.plan_id`,
    );
    const overrides = await client.query<{ feature_key: string; value: unknown }>(
      `SELECT feature_key, value FROM tenant_entitlement_overrides
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    );
    const settings = await client.query<{ feature_key: string; enabled: boolean }>(
      'SELECT feature_key, enabled FROM tenant_feature_settings',
    );

    return resolveFeatures({
      plan: toBool(plan.rows),
      overrides: toBool(overrides.rows),
      settings: toBool(settings.rows.map((r) => ({ feature_key: r.feature_key, value: r.enabled }))),
    });
  }

  /** Resolve every feature for the current request's clinic. */
  resolve(): Promise<Record<FeatureKey, ResolvedFeature>> {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), (client) => this.resolveWithin(client));
  }

  async isEnabled(client: PoolClient, key: FeatureKey): Promise<boolean> {
    return (await this.resolveWithin(client))[key].state === 'enabled';
  }

  /** Throw the same refusal FeatureGuard sends, from inside a service. */
  async assertEnabled(client: PoolClient, key: FeatureKey): Promise<void> {
    const resolved = (await this.resolveWithin(client))[key];
    if (resolved.state !== 'enabled') throw featureUnavailable(resolved);
  }
}

export function featureUnavailable(resolved: ResolvedFeature): ForbiddenException {
  const name = FEATURES[resolved.key].name;
  const message =
    resolved.state === 'not_in_plan'
      ? `${name} is not included in this clinic's plan.`
      : resolved.state === 'blocked'
        ? `${name} needs ${resolved.missing.map((k) => FEATURES[k].name).join(', ')} turned on first.`
        : `${name} is turned off for this clinic. An administrator can turn it on in Settings → Features.`;
  // 403, with a code of its own: not a missing permission (a different 403)
  // and not an unpaid clinic (402). The app tells the three apart by `code`.
  return new ForbiddenException({ code: 'feature_unavailable', feature: resolved.key, state: resolved.state, message });
}

export const FEATURE_METADATA_KEY = 'dentalcare:required-feature';

/**
 * Gate a controller or a route on a feature being enabled for the clinic.
 * Requires FeatureGuard in the controller's @UseGuards, after JwtAuthGuard —
 * route-coverage.spec fails the build when it is missing.
 */
export const RequiresFeature = (key: FeatureKey) => SetMetadata(FEATURE_METADATA_KEY, key);

/**
 * Enforces @RequiresFeature. Controller-level rather than global, so it runs
 * after authentication: an anonymous caller learns nothing about which
 * modules a clinic has.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<FeatureKey | undefined>(FEATURE_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!key) return true;
    const resolved = (await this.entitlements.resolve())[key];
    if (resolved.state !== 'enabled') throw featureUnavailable(resolved);
    return true;
  }
}

@Global()
@Module({
  providers: [EntitlementsService, FeatureGuard],
  exports: [EntitlementsService, FeatureGuard],
})
export class EntitlementsModule {}
