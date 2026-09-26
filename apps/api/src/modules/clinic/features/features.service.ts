import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { FEATURES, FEATURE_KEYS, isFeatureKey, type FeatureKey } from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { EntitlementsService } from '@/core/entitlements/entitlements.service';

/**
 * Settings → Features: what the clinic has, and its own switch for each.
 *
 * A clinic can switch a feature on only if its plan (or an override) entitles
 * it, and off only if nothing live depends on it being on. It can never
 * switch off a legal obligation: `alwaysOn` features have no switch.
 */
@Injectable()
export class FeaturesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  list() {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), (client) => this.listWithin(client));
  }

  private async listWithin(client: PoolClient) {
    const resolved = await this.entitlements.resolveWithin(client);
    const { rows } = await client.query<{
      feature_key: string;
      updated_at: string;
      updated_by_name: string | null;
    }>(
      `SELECT s.feature_key, s.updated_at, u.full_name AS updated_by_name
         FROM tenant_feature_settings s
         LEFT JOIN users u ON u.id = s.updated_by`,
    );
    const changed = new Map(rows.map((r) => [r.feature_key, r]));
    const expiring = await client.query<{ feature_key: string; expires_at: string }>(
      `SELECT feature_key, expires_at FROM tenant_entitlement_overrides
        WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at > now()`,
    );
    const expiry = new Map(expiring.rows.map((r) => [r.feature_key, r.expires_at]));

    return FEATURE_KEYS.map((key) => {
      const def = FEATURES[key];
      const r = resolved[key];
      const c = changed.get(key);
      return {
        key,
        name: def.name,
        description: def.description,
        group: def.group,
        alwaysOn: def.alwaysOn,
        state: r.state,
        entitledBy: r.entitledBy,
        missing: r.missing,
        overrideExpiresAt: r.entitledBy === 'override' ? (expiry.get(key) ?? null) : null,
        changedAt: c?.updated_at ?? null,
        changedBy: c?.updated_by_name ?? null,
      };
    });
  }

  async setEnabled(key: string, enabled: boolean, actor: ClinicAuditActor) {
    if (!isFeatureKey(key)) throw new NotFoundException('No such feature');
    const def = FEATURES[key];
    if (def.alwaysOn) {
      throw new BadRequestException(`${def.name} is always on and has no switch.`);
    }

    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const before = (await this.entitlements.resolveWithin(client))[key];
      if (enabled && before.state === 'not_in_plan') {
        throw new ConflictException({
          code: 'feature_not_in_plan',
          message: `${def.name} is not included in this clinic's plan.`,
        });
      }
      if (!enabled) await this.assertMaySwitchOff(client, key);

      await client.query(
        `INSERT INTO tenant_feature_settings (tenant_id, feature_key, enabled, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, feature_key)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tenantId, key, enabled, actor.userId],
      );
      await this.audit.record(client, actor, {
        action: 'features.updated',
        entityType: 'feature',
        entityId: null,
        summary: `Turned ${def.name.toLowerCase()} ${enabled ? 'on' : 'off'}`,
        metadata: { feature: key, enabled, previousState: before.state },
      });
      return this.listWithin(client);
    });
  }

  /**
   * Refuse to switch off a feature while something live depends on it being
   * on. For the cash drawer that is an open session: switching the module off
   * mid-shift would leave cash in a drawer nobody can close.
   */
  private async assertMaySwitchOff(client: PoolClient, key: FeatureKey): Promise<void> {
    if (key === 'cash_drawer') {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM drawer_sessions WHERE status IN ('open', 'counting', 'pending_approval')`,
      );
      const open = Number(rows[0]!.n);
      if (open > 0) {
        throw new ConflictException({
          code: 'feature_in_use',
          message: `Close ${open} open drawer session${open === 1 ? '' : 's'} before turning the cash drawer off.`,
        });
      }
    }
  }
}
