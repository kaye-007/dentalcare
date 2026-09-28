import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { isTimeZone } from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { PlatformAuditService, PlatformAuditActor } from '../audit/audit.service';
import { BCRYPT_ROUNDS } from '@/core/security/bcrypt';
import { MfaService } from '@/core/mfa/mfa.service';
import { revokeAllFor } from '@/core/sessions/session-store';
import { CreateTenantDto, DeleteTenantDto, SUBDOMAIN } from './dto/tenant.dto';

const RESERVED = [
  'www',
  'admin',
  'api',
  'app',
  'mail',
  'static',
  'console',
  'status',
  'docs',
  'support',
];

/** How long a deleted clinic can be restored before a person may purge it. */
const RESTORE_WINDOW_DAYS = 30;

/** An export larger than this is a job for the database provider's backups. */
const EXPORT_ROW_LIMIT = 200_000;

/**
 * Tables and columns an export leaves out. Sessions, second factors and
 * signing keys are credentials, not clinic data: a snapshot that carried them
 * would be a way to sign in as the clinic, or to sign its invoices.
 */
const EXPORT_SKIP_TABLES = new Set([
  'user_sessions',
  'user_mfa_factors',
  'user_mfa_recovery_codes',
  'fiscal_counters',
]);
const EXPORT_REDACT: Readonly<Record<string, readonly string[]>> = {
  users: ['password_hash', 'google_sub'],
  clinic_fiscal_settings: ['private_key_ciphertext', 'private_key_key_id'],
  // The clinic's WhatsApp Cloud API token: whoever holds it sends as the clinic.
  clinic_whatsapp_connections: ['encrypted_access_token', 'token_key_id'],
};

/**
 * Per-clinic figures for the console. Counts, sizes and the subscription —
 * never the clinic's own revenue or anything about a patient. NODE X runs the
 * platform; the clinic's books and records are the clinic's.
 *
 * The platform plane reads across tenants on the privileged connection, as
 * the rest of this service and the reminder scheduler already do.
 */
const STATS = `
  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)::int AS user_count,
  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active')::int AS active_user_count,
  (SELECT count(*) FROM patients x WHERE x.tenant_id = t.id AND x.status <> 'archived')::int AS patient_count,
  (SELECT count(*) FROM appointments a
    WHERE a.tenant_id = t.id
      AND a.starts_at >= date_trunc('month', now())
      AND a.starts_at <  date_trunc('month', now()) + interval '1 month')::int AS appointments_this_month,
  (SELECT coalesce(sum(d.byte_size), 0) FROM patient_documents d
    WHERE d.tenant_id = t.id AND d.deleted_at IS NULL)::bigint AS storage_bytes,
  (SELECT email FROM users u
    WHERE u.tenant_id = t.id AND u.role = 'admin'
    ORDER BY u.created_at LIMIT 1) AS owner_email`;

const TENANT_COLUMNS = `
  t.id, t.name, t.subdomain, t.status, t.trial_ends_at, t.created_at,
  t.deleted_at, t.purge_after, t.deletion_reason, t.status_before_delete,
  p.id AS plan_id, p.name AS plan_name, p.code AS plan_code, p.price_monthly`;

function mapStats<T extends Record<string, unknown>>(row: T) {
  return { ...row, storage_bytes: Number(row.storage_bytes ?? 0) };
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: PlatformAuditService,
    private readonly mfa: MfaService,
  ) {}

  async list() {
    const { rows } = await this.db.adminQuery(
      `SELECT ${TENANT_COLUMNS}, ${STATS}
         FROM tenants t
         LEFT JOIN plans p ON p.id = t.plan_id
        ORDER BY t.created_at DESC`,
    );
    return rows.map(mapStats);
  }

  /** The fleet at a glance. Monthly recurring revenue counts paying, active clinics only. */
  async overview() {
    const { rows } = await this.db.adminQuery<{
      active: number;
      suspended: number;
      archived: number;
      deleted: number;
      trials: number;
      mrr: string;
      patients: number;
      storage_bytes: string;
      appointments_this_month: number;
    }>(
      `SELECT count(*) FILTER (WHERE t.status = 'active')::int    AS active,
              count(*) FILTER (WHERE t.status = 'suspended')::int AS suspended,
              count(*) FILTER (WHERE t.status = 'archived')::int  AS archived,
              count(*) FILTER (WHERE t.status = 'deleted')::int   AS deleted,
              count(*) FILTER (WHERE t.status = 'active' AND t.trial_ends_at > now())::int AS trials,
              coalesce(sum(p.price_monthly) FILTER (
                WHERE t.status = 'active' AND t.trial_ends_at IS NULL), 0)::bigint AS mrr,
              (SELECT count(*) FROM patients WHERE status <> 'archived')::int AS patients,
              (SELECT coalesce(sum(byte_size), 0) FROM patient_documents WHERE deleted_at IS NULL)::bigint AS storage_bytes,
              (SELECT count(*) FROM appointments
                WHERE starts_at >= date_trunc('month', now())
                  AND starts_at <  date_trunc('month', now()) + interval '1 month')::int AS appointments_this_month
         FROM tenants t
         LEFT JOIN plans p ON p.id = t.plan_id`,
    );
    const r = rows[0]!;
    return {
      clinics: {
        active: r.active,
        suspended: r.suspended,
        archived: r.archived,
        deleted: r.deleted,
      },
      trials: r.trials,
      mrr: Number(r.mrr),
      patients: r.patients,
      storageBytes: Number(r.storage_bytes),
      appointmentsThisMonth: r.appointments_this_month,
    };
  }

  async getById(id: string) {
    const { rows } = await this.db.adminQuery(
      `SELECT ${TENANT_COLUMNS}, ${STATS},
              cs.currency, cs.timezone, cs.phone, cs.city, cs.tax_number,
              coalesce(fs.enabled, false) AS fiscalization_enabled
         FROM tenants t
         LEFT JOIN plans p ON p.id = t.plan_id
         LEFT JOIN clinic_settings cs ON cs.tenant_id = t.id
         LEFT JOIN clinic_fiscal_settings fs ON fs.tenant_id = t.id
        WHERE t.id = $1`,
      [id],
    );
    const tenant = rows[0];
    if (!tenant) throw new NotFoundException('Tenant not found');

    const staff = await this.db.adminQuery(
      `SELECT id, email, full_name, role, status
         FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [id],
    );
    const audit = await this.audit.listForEntity('tenant', id);
    return { ...mapStats(tenant), staff: staff.rows, audit };
  }

  /** Whether a subdomain can be given to a clinic, and if not, why. */
  async checkSubdomain(raw: string, exceptTenantId?: string) {
    const subdomain = raw.trim().toLowerCase();
    if (!SUBDOMAIN.test(subdomain)) {
      return {
        subdomain,
        available: false,
        reason: '3–30 lowercase letters, numbers or hyphens',
      };
    }
    if (RESERVED.includes(subdomain))
      return { subdomain, available: false, reason: 'Reserved' };
    const { rowCount } = await this.db.adminQuery(
      'SELECT 1 FROM tenants WHERE subdomain = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)',
      [subdomain, exceptTenantId ?? null],
    );
    return rowCount
      ? { subdomain, available: false, reason: 'Already in use' }
      : { subdomain, available: true, reason: null };
  }

  async create(dto: CreateTenantDto, actor: PlatformAuditActor) {
    const check = await this.checkSubdomain(dto.subdomain);
    if (!check.available) {
      throw new ConflictException(
        check.reason === 'Already in use'
          ? 'A clinic with that subdomain already exists'
          : `That subdomain is ${check.reason?.toLowerCase()}`,
      );
    }
    const subdomain = check.subdomain;
    if (dto.timezone && !isTimeZone(dto.timezone)) {
      throw new BadRequestException(`"${dto.timezone}" is not a time zone`);
    }

    const trialEnds =
      dto.trialDays && dto.trialDays > 0
        ? new Date(Date.now() + dto.trialDays * 86_400_000)
        : null;

    return this.db.withAdminTransaction(async (client) => {
      const t = await client.query<{ id: string }>(
        `INSERT INTO tenants (name, subdomain, status, plan_id, trial_ends_at)
         VALUES ($1, $2, 'active', $3, $4)
         RETURNING id`,
        [dto.clinicName, subdomain, dto.planId ?? null, trialEnds],
      );
      const tenantId = t.rows[0]!.id;

      // Every table below is FORCE RLS, which binds this role too.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
        tenantId,
      ]);

      const hash = await bcrypt.hash(dto.ownerPassword, BCRYPT_ROUNDS);
      await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status)
         VALUES ($1, $2, $3, $4, 'admin', 'active')`,
        [tenantId, dto.ownerEmail, hash, dto.ownerFullName],
      );

      // The clinic's first settings. Anything not given takes the column
      // default, which is what a clinic that never opened Settings has anyway.
      // A new clinic keeps its books in lek unless told otherwise, and a clinic
      // in lek quotes patients from abroad in euro as well (0012). A clinic in
      // Albania or Kosovo writes to its patients in Albanian; anywhere else in
      // English. Settings changes either, and nothing else follows from it.
      await client.query(
        `INSERT INTO clinic_settings (tenant_id, currency, timezone, phone_country_code,
                                      phone, address, city, tax_number, quote_currency,
                                      reminder_locale)
         VALUES ($1, coalesce($2, 'ALL'), coalesce($3, 'Europe/Tirane'), coalesce($4, '355'),
                 $5, $6, $7, $8,
                 CASE WHEN coalesce($2, 'ALL') = 'ALL' THEN 'EUR' END,
                 CASE WHEN coalesce($4, '355') IN ('355', '383') THEN 'sq' ELSE 'en' END)`,
        [
          tenantId,
          dto.currency ?? null,
          dto.timezone ?? null,
          dto.phoneCountryCode ?? null,
          dto.phone?.trim() || null,
          dto.address?.trim() || null,
          dto.city?.trim() || null,
          dto.taxNumber?.trim().toUpperCase().replace(/\s+/g, '') || null,
        ],
      );

      await this.audit.record(client, actor, {
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: tenantId,
        metadata: {
          name: dto.clinicName,
          subdomain,
          ownerEmail: dto.ownerEmail,
          trialDays: dto.trialDays ?? 0,
          planId: dto.planId ?? null,
          currency: dto.currency ?? 'ALL',
        },
      });

      return { id: tenantId, subdomain };
    });
  }

  async updateStatus(
    id: string,
    status: 'active' | 'suspended' | 'archived',
    actor: PlatformAuditActor,
  ) {
    return this.db.withAdminTransaction(async (client) => {
      const current = await client.query<{ status: string; subdomain: string }>(
        'SELECT status, subdomain FROM tenants WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Tenant not found');
      if (row.status === 'deleted') {
        throw new ConflictException(
          'This clinic is deleted. Restore it before changing its status.',
        );
      }

      await client.query(
        'UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2',
        [status, id],
      );

      const action =
        status === 'suspended'
          ? 'tenant.suspended'
          : status === 'archived'
            ? 'tenant.archived'
            : 'tenant.reactivated';

      await this.audit.record(client, actor, {
        action,
        entityType: 'tenant',
        entityId: id,
        metadata: { from: row.status, to: status, subdomain: row.subdomain },
      });

      return { id, status };
    });
  }

  async setPlan(id: string, planId: string | null, actor: PlatformAuditActor) {
    return this.db.withAdminTransaction(async (client) => {
      const { rows } = await client.query<{ plan_id: string | null; subdomain: string }>(
        'SELECT plan_id, subdomain FROM tenants WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!rows[0]) throw new NotFoundException('Tenant not found');
      if (planId) {
        const plan = await client.query(
          'SELECT 1 FROM plans WHERE id = $1 AND is_active',
          [planId],
        );
        if (!plan.rowCount)
          throw new NotFoundException('That plan does not exist or is retired');
      }
      await client.query(
        'UPDATE tenants SET plan_id = $1, updated_at = now() WHERE id = $2',
        [planId, id],
      );
      await this.audit.record(client, actor, {
        action: 'tenant.plan_changed',
        entityType: 'tenant',
        entityId: id,
        metadata: { from: rows[0].plan_id, to: planId, subdomain: rows[0].subdomain },
      });
      return { id, planId };
    });
  }

  /**
   * Move a clinic to a new address. Every bookmark, saved password and
   * installed shortcut on the old one stops working the moment this commits,
   * so it is audited with both names.
   */
  async changeSubdomain(id: string, next: string, actor: PlatformAuditActor) {
    const check = await this.checkSubdomain(next, id);
    if (!check.available)
      throw new ConflictException(`That subdomain is ${check.reason?.toLowerCase()}`);
    return this.db.withAdminTransaction(async (client) => {
      const { rows } = await client.query<{ subdomain: string }>(
        'SELECT subdomain FROM tenants WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!rows[0]) throw new NotFoundException('Tenant not found');
      await client
        .query('UPDATE tenants SET subdomain = $1, updated_at = now() WHERE id = $2', [
          check.subdomain,
          id,
        ])
        .catch((err: { code?: string }) => {
          if (err.code === '23505')
            throw new ConflictException('A clinic with that subdomain already exists');
          throw err;
        });
      await this.audit.record(client, actor, {
        action: 'tenant.subdomain_changed',
        entityType: 'tenant',
        entityId: id,
        metadata: { from: rows[0].subdomain, to: check.subdomain },
      });
      return { id, subdomain: check.subdomain };
    });
  }

  /**
   * Delete a clinic — which removes nothing. Access stops at once (the tenant
   * middleware admits 'active' only) and every row stays, restorable for
   * RESTORE_WINDOW_DAYS. A purge after that is deliberately not automated.
   */
  async softDelete(id: string, dto: DeleteTenantDto, actor: PlatformAuditActor) {
    return this.db.withAdminTransaction(async (client) => {
      const { rows } = await client.query<{ status: string; subdomain: string }>(
        'SELECT status, subdomain FROM tenants WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('Tenant not found');
      if (row.status === 'deleted')
        throw new ConflictException('This clinic is already deleted');
      if (dto.confirmSubdomain.trim().toLowerCase() !== row.subdomain) {
        throw new BadRequestException('Type the clinic’s subdomain exactly to confirm');
      }
      const { rows: updated } = await client.query<{ purge_after: Date }>(
        `UPDATE tenants
            SET status = 'deleted', status_before_delete = status, deleted_at = now(),
                deleted_by = $2, deletion_reason = $3,
                purge_after = now() + make_interval(days => $4), updated_at = now()
          WHERE id = $1
          RETURNING purge_after`,
        [id, actor.id, dto.reason.trim(), RESTORE_WINDOW_DAYS],
      );
      await this.audit.record(client, actor, {
        action: 'tenant.deleted',
        entityType: 'tenant',
        entityId: id,
        metadata: {
          subdomain: row.subdomain,
          from: row.status,
          reason: dto.reason.trim(),
        },
      });
      return {
        id,
        status: 'deleted' as const,
        purgeAfter: updated[0]!.purge_after.toISOString(),
      };
    });
  }

  /** Bring a deleted clinic back, suspended: switching it on again is its own decision. */
  async restore(id: string, actor: PlatformAuditActor) {
    return this.db.withAdminTransaction(async (client) => {
      const { rows } = await client.query<{
        status: string;
        subdomain: string;
        status_before_delete: string | null;
      }>(
        'SELECT status, subdomain, status_before_delete FROM tenants WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('Tenant not found');
      if (row.status !== 'deleted')
        throw new ConflictException('Only a deleted clinic can be restored');
      await client.query(
        `UPDATE tenants
            SET status = 'suspended', deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL,
                purge_after = NULL, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      await this.audit.record(client, actor, {
        action: 'tenant.restored',
        entityType: 'tenant',
        entityId: id,
        metadata: {
          subdomain: row.subdomain,
          statusBeforeDelete: row.status_before_delete,
        },
      });
      return { id, status: 'suspended' as const };
    });
  }

  /**
   * A logical snapshot of one clinic: every row of every table that carries
   * its tenant_id, as JSON, with credentials left out. For data portability,
   * for a clinic that is leaving, and as evidence before a purge.
   *
   * It is NOT the platform's backup. Point-in-time recovery of the database
   * belongs to the database provider, and restoring rows into a live, shared
   * schema — append-only tables, locking triggers, other clinics' foreign
   * keys — is a supervised operation, not a button. See DEPLOYMENT.md,
   * "Backups and restore".
   */
  async exportSnapshot(id: string, actor: PlatformAuditActor) {
    // One transaction: the snapshot is read at a single point in time, and the
    // audit row that says it was taken commits with it or not at all.
    return this.db.withAdminTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const { rows: t } = await client.query(
        'SELECT id, name, subdomain, status, plan_id, trial_ends_at, created_at FROM tenants WHERE id = $1',
        [id],
      );
      if (!t[0]) throw new NotFoundException('Tenant not found');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [id]);

      const { rows: tables } = await client.query<{ table_name: string }>(
        `SELECT c.table_name
           FROM information_schema.columns c
           JOIN information_schema.tables tb
             ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
            AND tb.table_type = 'BASE TABLE'
          ORDER BY c.table_name`,
      );
      const { rows: migration } = await client
        .query<{ name: string }>(
          'SELECT name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1',
        )
        .catch(() => ({ rows: [] as { name: string }[] }));

      const data: Record<string, unknown[]> = {};
      const counts: Record<string, number> = {};
      let total = 0;
      for (const { table_name: table } of tables) {
        if (EXPORT_SKIP_TABLES.has(table)) continue;
        // Identifier from the catalogue, quoted anyway.
        const { rows } = await client.query(
          `SELECT * FROM "${table.replace(/"/g, '""')}" WHERE tenant_id = $1 LIMIT ${EXPORT_ROW_LIMIT + 1}`,
          [id],
        );
        total += rows.length;
        if (total > EXPORT_ROW_LIMIT) {
          throw new PayloadTooLargeException(
            `This clinic has more than ${EXPORT_ROW_LIMIT.toLocaleString('en')} rows; export it from a database backup instead.`,
          );
        }
        for (const column of EXPORT_REDACT[table] ?? []) {
          for (const row of rows) if (column in row) row[column] = null;
        }
        data[table] = rows;
        counts[table] = rows.length;
      }

      const body = JSON.stringify(data);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const exportedAt = new Date().toISOString();
      const snapshot =
        `{"format":"dentalcare-clinic-export","version":1,"exportedAt":${JSON.stringify(exportedAt)},` +
        `"schema":${JSON.stringify(migration[0]?.name ?? null)},"tenant":${JSON.stringify(t[0])},` +
        `"counts":${JSON.stringify(counts)},"sha256":"${sha256}","redacted":${JSON.stringify(
          {
            tables: [...EXPORT_SKIP_TABLES],
            columns: EXPORT_REDACT,
          },
        )},"tables":${body}}`;

      await this.audit.record(client, actor, {
        action: 'tenant.exported',
        entityType: 'tenant',
        entityId: id,
        metadata: { subdomain: t[0].subdomain, rows: total, sha256 },
      });
      return { snapshot, fileName: `${t[0].subdomain}-${exportedAt.slice(0, 10)}.json` };
    });
  }

  async setTrial(id: string, days: number | null, actor: PlatformAuditActor) {
    return this.db.withAdminTransaction(async (client) => {
      const current = await client.query<{
        trial_ends_at: Date | null;
        subdomain: string;
      }>('SELECT trial_ends_at, subdomain FROM tenants WHERE id = $1 FOR UPDATE', [id]);
      const row = current.rows[0];
      if (!row) throw new NotFoundException('Tenant not found');

      const next = days === null ? null : new Date(Date.now() + days * 86_400_000);

      await client.query(
        'UPDATE tenants SET trial_ends_at = $1, updated_at = now() WHERE id = $2',
        [next, id],
      );

      await this.audit.record(client, actor, {
        action: days === null ? 'tenant.converted_to_paid' : 'tenant.trial_set',
        entityType: 'tenant',
        entityId: id,
        metadata: {
          subdomain: row.subdomain,
          from: row.trial_ends_at ? row.trial_ends_at.toISOString() : null,
          to: next ? next.toISOString() : null,
          days,
        },
      });

      return { id, trialEndsAt: next ? next.toISOString() : null };
    });
  }

  /**
   * Reset a clinic user's password from the platform side — the recovery path
   * when a doctor locks themselves out, since the clinic plane has no email
   * flow.
   *
   * This is NODE X reaching into a customer's clinic, so it is recorded twice:
   * in the platform audit log, and in the CLINIC's own trail, where the doctor
   * can see it. A support action the customer cannot see is indistinguishable
   * from one they were not told about.
   */
  async resetUserPassword(
    tenantId: string,
    userId: string,
    password: string,
    actor: PlatformAuditActor,
  ) {
    return this.db.withAdminTransaction(async (client) => {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const res = await client.query<{ email: string; full_name: string }>(
        `UPDATE users SET password_hash = $3, updated_at = now()
          WHERE id = $2 AND tenant_id = $1
          RETURNING email, full_name`,
        [tenantId, userId, hash],
      );
      const user = res.rows[0];
      if (!user) throw new NotFoundException('User not found in this clinic');

      await this.audit.record(client, actor, {
        action: 'tenant.user_password_reset',
        entityType: 'tenant',
        entityId: tenantId,
        metadata: { userId, email: user.email },
      });

      // The clinic's own log. clinic_audit_log has FORCE ROW LEVEL SECURITY,
      // which applies to the table owner as well as to app_user, so the tenant
      // has to be set for this transaction before the insert will land.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
        tenantId,
      ]);
      // user_sessions is FORCE RLS too, so this also waits for the tenant.
      await revokeAllFor(client, 'user_sessions', userId, 'password_reset');
      await client.query(
        `INSERT INTO clinic_audit_log
           (tenant_id, actor_user_id, actor_label, actor_role,
            action, entity_type, entity_id, summary, metadata)
         VALUES ($1, NULL, $2, 'platform', 'staff.password_reset', 'user', $3, $4, $5)`,
        [
          tenantId,
          actor.label,
          userId,
          `NODE X support reset the password for ${user.full_name}`,
          JSON.stringify({ email: user.email, viaPlatform: true }),
        ],
      );

      return { reset: true as const, email: user.email };
    });
  }

  /**
   * Turn off a clinic user's two-step sign-in from the platform side.
   *
   * The clinic's own administrator can do this for colleagues (StaffService),
   * but not for themselves — so a sole administrator who has lost their phone
   * and their recovery codes has exactly one way back, and it is this. Like
   * a password reset, it is recorded in the platform log AND in the clinic's
   * own trail, where the clinic can see NODE X did it.
   */
  async resetUserMfa(tenantId: string, userId: string, actor: PlatformAuditActor) {
    return this.db.withAdminTransaction(async (client) => {
      // Every table touched below is FORCE RLS; set the tenant first.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
        tenantId,
      ]);
      const { rows } = await client.query<{ email: string; full_name: string }>(
        'SELECT email, full_name FROM users WHERE id = $1 AND tenant_id = $2',
        [userId, tenantId],
      );
      const user = rows[0];
      if (!user) throw new NotFoundException('User not found in this clinic');

      const hadFactor = await this.mfa.disable(client, 'clinic', userId);
      await revokeAllFor(client, 'user_sessions', userId, 'mfa_changed');

      await this.audit.record(client, actor, {
        action: 'tenant.user_mfa_reset',
        entityType: 'tenant',
        entityId: tenantId,
        metadata: { userId, email: user.email, hadFactor },
      });
      await client.query(
        `INSERT INTO clinic_audit_log
           (tenant_id, actor_user_id, actor_label, actor_role,
            action, entity_type, entity_id, summary, metadata)
         VALUES ($1, NULL, $2, 'platform', 'staff.mfa_reset', 'user', $3, $4, $5)`,
        [
          tenantId,
          actor.label,
          userId,
          `NODE X support reset two-step sign-in for ${user.full_name}`,
          JSON.stringify({ email: user.email, viaPlatform: true, hadFactor }),
        ],
      );

      return { reset: true as const, email: user.email, hadFactor };
    });
  }
}
