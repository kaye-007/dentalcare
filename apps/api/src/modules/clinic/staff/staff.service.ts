import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditService, ClinicAuditActor } from '@/core/audit/clinic-audit.service';
import { BCRYPT_ROUNDS } from '@/core/security/bcrypt';
import { MfaService } from '@/core/mfa/mfa.service';
import { moneyText } from '@/core/money/clinic-currency';
import { revokeAllFor } from '@/core/sessions/session-store';
import { CreateStaffDto, RecordSalaryPaymentDto, UpdateStaffDto } from './dto/staff.dto';

/* ── service ─────────────────────────────────────────────── */

/** How the activity trail names each role. Matches the SPA's ROLE_LABELS. */
const ROLE_TITLES: Readonly<Record<string, string>> = {
  admin: 'Administrator',
  dentist: 'Dentist',
  hygienist: 'Hygienist',
  assistant: 'Assistant',
  receptionist: 'Reception',
};

interface StaffRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  status: string;
  position: string | null;
  sees_patients: boolean;
  home_operatory_id: string | null;
  two_step: boolean;
  fiscal_operator_code: string | null;
  created_at: string;
}

// Salary is no longer part of a staff record (removed from the product,
// 2026-09): the columns and the salary log stay in the database, unread here.
const FULL = `id, full_name, email, role, status, position, sees_patients, home_operatory_id, fiscal_operator_code, created_at,
  EXISTS (SELECT 1 FROM user_mfa_factors f WHERE f.user_id = users.id AND f.confirmed_at IS NOT NULL) AS two_step`;

/**
 * A staff record. Everyone at the clinic sees the team: who they are, what
 * they do, whether they see patients. Only whoever manages staff also sees
 * how each account signs in and its fiscal operator code.
 */
function mapStaff(r: StaffRow, forManager: boolean) {
  const base = {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    role: r.role,
    status: r.status,
    position: r.position,
    seesPatients: r.sees_patients,
    /** The room their bookings start in. */
    homeOperatoryId: r.home_operatory_id,
    createdAt: r.created_at,
  };
  return forManager
    ? { ...base, twoStepEnabled: r.two_step, fiscalOperatorCode: r.fiscal_operator_code }
    : base;
}

/** Whether a role sees patients unless told otherwise. */
function seesPatientsByDefault(role: string): boolean {
  return role === 'dentist' || role === 'hygienist';
}

@Injectable()
export class StaffService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
    private readonly mfa: MfaService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  list(forManager: boolean) {
    return this.tx(async (client) => {
      const { rows } = await client.query<StaffRow>(
        `SELECT ${FULL} FROM users ORDER BY created_at`,
      );
      return rows.map((r) => mapStaff(r, forManager));
    });
  }

  create(dto: CreateStaffDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
      try {
        const { rows } = await client.query<StaffRow>(
          `INSERT INTO users (tenant_id, email, password_hash, full_name, role, status,
                              position, sees_patients)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7) RETURNING ${FULL}`,
          [
            tenantId,
            dto.email,
            hash,
            dto.fullName,
            dto.role,
            dto.position?.trim() || null,
            dto.seesPatients ?? seesPatientsByDefault(dto.role),
          ],
        );
        await this.audit.record(client, actor, {
          action: 'staff.created',
          entityType: 'user',
          entityId: rows[0]!.id,
          summary: `Created ${ROLE_TITLES[dto.role] ?? dto.role} account for ${dto.fullName}`,
          metadata: { email: dto.email, role: dto.role, position: dto.position ?? null },
        });
        return mapStaff(rows[0]!, true);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException('A staff member with that email already exists');
        }
        throw err;
      }
    });
  }

  update(id: string, dto: UpdateStaffDto, actor: ClinicAuditActor) {
    // "Demotion" is any move off admin, not one named value.
    const selfDemoting = dto.role !== undefined && dto.role !== 'admin';
    if (id === actor.userId && (dto.status === 'disabled' || selfDemoting)) {
      throw new BadRequestException('You cannot disable or demote your own account');
    }
    const cols: Record<string, string> = {
      fullName: 'full_name',
      role: 'role',
      status: 'status',
      position: 'position',
      seesPatients: 'sees_patients',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      const v = (dto as unknown as Record<string, unknown>)[k];
      if (v !== undefined) {
        params.push(v === '' ? null : v);
        sets.push(`${col} = $${params.length}`);
      }
    }
    return this.tx(async (client) => {
      if (!sets.length) {
        const r = await client.query<StaffRow>(
          `SELECT ${FULL} FROM users WHERE id = $1`,
          [id],
        );
        if (!r.rows[0]) throw new NotFoundException('Staff member not found');
        return mapStaff(r.rows[0], true);
      }
      // Read the row BEFORE the write: "changed the role to admin" is worth
      // little without what it was.
      const before = await client.query<StaffRow>(
        `SELECT ${FULL} FROM users WHERE id = $1`,
        [id],
      );
      if (!before.rows[0]) throw new NotFoundException('Staff member not found');
      params.push(id);
      const { rows } = await client.query<StaffRow>(
        `UPDATE users SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length} RETURNING ${FULL}`,
        params,
      );
      if (!rows[0]) throw new NotFoundException('Staff member not found');
      const prev = before.rows[0];
      const next = rows[0];
      const changed = Object.keys(cols).filter(
        (k) => (dto as unknown as Record<string, unknown>)[k] !== undefined,
      );
      const roleMoved = prev.role !== next.role;
      const seesMoved = prev.sees_patients !== next.sees_patients;

      // A disabled account, or one whose authority just changed, keeps no
      // session. Its access token lapses within JWT_ACCESS_TTL and the next
      // refresh is refused; a role change signs in again under the new role.
      if (prev.status !== 'disabled' && next.status === 'disabled') {
        await revokeAllFor(client, 'user_sessions', id, 'account_disabled');
      } else if (roleMoved) {
        await revokeAllFor(client, 'user_sessions', id, 'role_changed');
      }
      await this.audit.record(client, actor, {
        action: 'staff.updated',
        entityType: 'user',
        entityId: id,
        summary: roleMoved
          ? `Changed ${next.full_name}'s access from ${prev.role} to ${next.role}`
          : seesMoved
            ? `${next.full_name} ${next.sees_patients ? 'now sees patients' : 'no longer sees patients'}`
            : `Updated ${next.full_name} (${changed.join(', ') || 'no fields'})`,
        metadata: {
          fields: changed,
          ...(roleMoved ? { roleFrom: prev.role, roleTo: next.role } : {}),
          ...(seesMoved ? { seesPatients: next.sees_patients } : {}),
        },
      });
      return mapStaff(rows[0], true);
    });
  }

  /**
   * Owner-initiated password reset for a staff member. The owner never sees
   * the existing password, so this sets a new one outright — the recovery path
   * for a locked-out colleague, since the clinic plane has no email flow.
   */
  resetPassword(staffId: string, newPassword: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const res = await client.query<{ full_name: string }>(
        `UPDATE users SET password_hash = $2, updated_at = now()
          WHERE id = $1 RETURNING full_name`,
        [staffId, hash],
      );
      if (!res.rowCount) throw new NotFoundException('Staff member not found');
      // A reset usually means the old password is compromised or forgotten;
      // either way no session opened with it should survive.
      await revokeAllFor(client, 'user_sessions', staffId, 'password_reset');
      await this.audit.record(client, actor, {
        action: 'staff.password_reset',
        entityType: 'user',
        entityId: staffId,
        summary: `Reset the password for ${res.rows[0]!.full_name}`,
      });
      return { reset: true };
    });
  }

  /**
   * Turn off a colleague's two-step sign-in — the recovery path for a lost
   * phone AND lost recovery codes. They sign in with their password next, and
   * enrol again if MFA is required for them. Every session they hold ends.
   *
   * Not for your own account: that would let a stolen administrator session
   * remove the second factor without ever presenting one. Your own factor is
   * changed from account security, with your password and a current code.
   */
  resetMfa(staffId: string, actor: ClinicAuditActor) {
    if (staffId === actor.userId) {
      throw new BadRequestException(
        'Use your own account security settings to change your two-step sign-in.',
      );
    }
    return this.tx(async (client) => {
      const { rows } = await client.query<{ full_name: string }>(
        'SELECT full_name FROM users WHERE id = $1',
        [staffId],
      );
      if (!rows[0]) throw new NotFoundException('Staff member not found');
      const hadFactor = await this.mfa.disable(client, 'clinic', staffId);
      await revokeAllFor(client, 'user_sessions', staffId, 'mfa_changed');
      await this.audit.record(client, actor, {
        action: 'staff.mfa_reset',
        entityType: 'user',
        entityId: staffId,
        summary: `Reset two-step sign-in for ${rows[0].full_name}`,
        metadata: { hadFactor },
      });
      return { reset: true as const, hadFactor };
    });
  }

  /* ── salary payment log (owner-only) ── */
  recordSalaryPayment(
    staffId: string,
    dto: RecordSalaryPaymentDto,
    actor: ClinicAuditActor,
  ) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const staff = await client.query<{ position: string | null; full_name: string }>(
        'SELECT position, full_name FROM users WHERE id = $1',
        [staffId],
      );
      if (!staff.rowCount) throw new NotFoundException('Staff member not found');
      const { rows } = await client.query(
        `INSERT INTO salary_payments (tenant_id, staff_id, position, amount, paid_on, note, created_by)
         VALUES ($1,$2,$3,$4, coalesce($5::date, CURRENT_DATE), $6, $7)
         RETURNING id, amount, paid_on::text AS paid_on, note, position`,
        [
          tenantId,
          staffId,
          staff.rows[0]!.position,
          dto.amount,
          dto.paidOn ?? null,
          dto.note?.trim() || null,
          actor.userId,
        ],
      );
      const r = rows[0]!;
      await this.audit.record(client, actor, {
        action: 'salary.recorded',
        entityType: 'salary_payment',
        entityId: r.id,
        summary: `Paid ${await moneyText(client, r.amount)} salary to ${staff.rows[0]!.full_name}`,
        metadata: { staffId, amount: r.amount, paidOn: r.paid_on },
      });
      return {
        id: r.id,
        staffId,
        amount: r.amount,
        paidOn: r.paid_on,
        note: r.note,
        position: r.position,
      };
    });
  }

  listSalaryPayments() {
    return this.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT sp.id, sp.amount, sp.paid_on::text AS paid_on, sp.note, sp.position,
                u.full_name AS staff_name
           FROM salary_payments sp
           JOIN users u ON u.id = sp.staff_id
          ORDER BY sp.paid_on DESC, sp.created_at DESC
          LIMIT 200`,
      );
      return rows.map((r) => ({
        id: r.id,
        staffName: r.staff_name,
        position: r.position,
        amount: r.amount,
        paidOn: r.paid_on,
        note: r.note,
      }));
    });
  }
}
