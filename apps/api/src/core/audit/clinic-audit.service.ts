import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { RequestContextService } from '@/core/request-context/request-context';
import { Role, normalizeRole } from '@dentalcare/shared';

/**
 * The clinic-plane audit log.
 *
 * Distinct from `platform/audit`, which records what NODE X does to clinics.
 * This records what a clinic's own staff do inside it, and it exists for one
 * concrete reason: reception can fix a mistake, and must not be able to make
 * one disappear. Voiding a cash payment is allowed; voiding it invisibly is
 * not.
 *
 * Two rules make it evidence rather than a log file:
 *
 *  1. Every entry is written with the SAME client as the thing it describes,
 *     inside that transaction. A payment that commits without its audit row,
 *     or an audit row for a payment that rolled back, would both be worse than
 *     no log at all.
 *
 *  2. Nothing can amend it. Migration 0018 revokes UPDATE/DELETE/TRUNCATE from
 *     app_user and adds a trigger that raises on all three, so the row that
 *     lands here is the row that stays here.
 */

export const AUDIT_ACTIONS = [
  'invoice.created',
  'invoice.cancelled',
  'invoice.adjusted',
  'payment.recorded',
  'payment.voided',
  'expense.recorded',
  'expense.voided',
  'staff.created',
  'staff.updated',
  'staff.password_reset',
  'staff.mfa_reset',
  // Account security (0005). Sign-ins themselves are not audited here; the
  // session table records those.
  'auth.mfa_enrolled',
  'auth.mfa_disabled',
  'auth.recovery_codes_regenerated',
  'auth.recovery_code_used',
  'salary.recorded',
  'settings.updated',
  'settings.logo_changed',
  'schedule.closure_added',
  'schedule.closure_removed',
  'patient.imported',
  'patient.photo_changed',
  'fiscal.settings_updated',
  'fiscal.certificate_installed',
  'fiscal.invoice_registered',
  'fiscal.cash_deposit_registered',
  'treatment.created',
  'treatment.updated',
  'document.deleted',
  'inventory.item_created',
  'inventory.item_updated',
  'inventory.item_archived',
  'inventory.movement_recorded',
  'inventory.lot_tracking_enabled',
  'inventory.lot_recalled',

  // Lab work, and the labs and suppliers the clinic deals with (0020).
  'partner.created',
  'partner.updated',
  'lab.order_created',
  'lab.order_updated',
  'lab.order_moved',

  // Features and the cash drawer (0013, 0014).
  'features.updated',
  'drawer.created',
  'drawer.updated',
  'drawer.policy_updated',
  'drawer.opened',
  'drawer.cash_dropped',
  'drawer.float_added',
  'drawer.payout',
  'drawer.no_sale',
  'drawer.counted',
  'drawer.closed',
  'drawer.approval_requested',
  'drawer.variance_approved',
  'drawer.force_closed',
  'auth.approval_pin_set',

  // Patients and the clinical record (0004). Writes only; who READ a record
  // goes to patient_access_log, which is a different question with a
  // different volume.
  'patient.created',
  'patient.updated',
  'patient.archived',
  'patient.restored',
  'clinical.note_added',
  'clinical.note_withdrawn',
  'clinical.finding_recorded',
  'clinical.finding_updated',
  'clinical.finding_withdrawn',
  'clinical.procedure_logged',
  'clinical.procedure_updated',
  'clinical.procedure_signed',
  'clinical.procedure_withdrawn',
  'clinical.perio_exam_started',
  'clinical.perio_exam_updated',
  'clinical.perio_readings_saved',
  'clinical.perio_exam_signed',
  'clinical.perio_exam_withdrawn',
  'clinical.history_recorded',
  'clinical.history_updated',
  'clinical.history_withdrawn',
  'whatsapp.connected',
  'whatsapp.disconnected',
  'whatsapp.template_saved',
  'whatsapp.template_deleted',
  'whatsapp.reminders_sent',
  'patient.whatsapp_consent',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface ClinicAuditActor {
  userId: string;
  /** Email — the snapshot that survives the account being unlinked. */
  label: string;
  /** Role AT THE TIME. A later promotion must not rewrite old rows. */
  role: Role;
}

export interface ClinicAuditEntry {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /** One human-readable line. The Activity page reads this, not metadata. */
  summary: string;
  metadata?: Record<string, unknown>;
}

interface Executor {
  query: PoolClient['query'];
}

/**
 * Build an actor from a verified access token.
 *
 * Structurally typed rather than importing AccessTokenPayload, because core/
 * must not depend on tenant/. Fails closed: an unresolvable role is a 401, not
 * an entry attributed to nobody.
 */
export function auditActor(user?: {
  sub: string;
  email: string;
  role: unknown;
}): ClinicAuditActor {
  if (!user) throw new UnauthorizedException();
  const role = normalizeRole(user.role);
  if (!role) throw new UnauthorizedException('Your account has no valid access role');
  return { userId: user.sub, label: user.email, role };
}

export interface AuditFilter {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  /** ISO dates, inclusive. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  actor: {
    userId: string | null;
    label: string;
    role: string;
    currentName: string | null;
  };
}

@Injectable()
export class ClinicAuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly request: RequestContextService,
  ) {}

  /**
   * Record an action. MUST be given the client of the transaction that
   * performed it — never `this.db` — so the two commit or fail together.
   *
   * The request it came from — id, client IP, user agent — is recorded with
   * it (0013). A scheduler has no request, and records NULL rather than a
   * made-up one.
   */
  async record(
    executor: Executor,
    actor: ClinicAuditActor,
    entry: ClinicAuditEntry,
  ): Promise<void> {
    const tenantId = this.tenant.getRequiredTenantId();
    const req = this.request.get();
    await executor.query(
      `INSERT INTO clinic_audit_log
         (tenant_id, actor_user_id, actor_label, actor_role,
          action, entity_type, entity_id, summary, metadata,
          request_id, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        tenantId,
        actor.userId,
        actor.label,
        actor.role,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.summary,
        JSON.stringify(entry.metadata ?? {}),
        req?.requestId ?? null,
        req?.ip ?? null,
        req?.userAgent ?? null,
      ],
    );
  }

  /** Read the log. Gated on `audit:read`, which only the doctor holds. */
  async list(filter: AuditFilter = {}): Promise<{ items: AuditRow[]; total: number }> {
    const tenantId = this.tenant.getRequiredTenantId();
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$$', `$${params.length}`));
    };

    if (filter.action) add('a.action = $$', filter.action);
    if (filter.entityType) add('a.entity_type = $$', filter.entityType);
    if (filter.entityId) add('a.entity_id = $$', filter.entityId);
    if (filter.actorUserId) add('a.actor_user_id = $$', filter.actorUserId);
    // Days are the clinic's (0023): its midnight, not the server's UTC one.
    if (filter.from)
      add(
        'a.created_at >= ($$::date::timestamp AT TIME ZONE clinic_zone())',
        filter.from,
      );
    // Inclusive of the whole end day, which is what a date picker means.
    if (filter.to)
      add(
        'a.created_at < (($$::date + 1)::timestamp AT TIME ZONE clinic_zone())',
        filter.to,
      );

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    return this.db.withTenant(tenantId, async (client) => {
      const counted = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM clinic_audit_log a ${clause}`,
        params,
      );
      const { rows } = await client.query(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary, a.metadata,
                a.created_at, a.actor_user_id, a.actor_label, a.actor_role,
                u.full_name AS current_name
           FROM clinic_audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
           ${clause}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      return {
        total: Number(counted.rows[0]!.n),
        items: rows.map((r) => ({
          id: r.id,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          summary: r.summary,
          metadata: r.metadata ?? {},
          createdAt: r.created_at,
          actor: {
            userId: r.actor_user_id,
            label: r.actor_label,
            role: r.actor_role,
            currentName: r.current_name,
          },
        })),
      };
    });
  }
}
