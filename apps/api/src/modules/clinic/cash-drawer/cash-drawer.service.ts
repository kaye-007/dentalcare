import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PoolClient } from 'pg';
import {
  CURRENCIES,
  DEFAULT_VARIANCE_THRESHOLDS,
  VARIANCE_NOTE_MIN_LENGTH,
  can,
  countTotal,
  expectedCash,
  formatMoney,
  isCurrency,
  normalizeRole,
  varianceBand,
  type CurrencyCode,
  type VarianceBand,
  type VarianceThresholds,
} from '@dentalcare/shared';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { RequestContextService } from '@/core/request-context/request-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import { EntitlementsService } from '@/core/entitlements/entitlements.service';
import { clinicCurrency } from '@/core/money/clinic-currency';
import { BCRYPT_ROUNDS } from '@/core/security/bcrypt';
import { FiscalService } from '@/modules/clinic/fiscalization/fiscal.service';
import { appendEvent, readEvents, verifyChain } from './drawer-ledger';
import {
  ApprovedMovementDto,
  CloseSessionDto,
  CreateDrawerDto,
  DropDto,
  ForceCloseDto,
  ListSessionsQueryDto,
  OpenSessionDto,
  SetApprovalPinDto,
  SubmitCountDto,
  UpdateDrawerDto,
  UpdatePolicyDto,
} from './dto/cash-drawer.dto';

/** What a session was opened under. Frozen on the row, so a policy change mid-shift changes nothing. */
export interface PolicySnapshot {
  blindCount: boolean;
  maxRecounts: number;
  thresholds: Partial<Record<CurrencyCode, VarianceThresholds>>;
  defaultFloat: Partial<Record<CurrencyCode, number>>;
}

const UNCLOSED = `('open','counting','pending_approval')`;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

interface SessionRow {
  id: string;
  drawer_id: string;
  drawer_name: string;
  tcr_code: string | null;
  location_id: string;
  business_date: string;
  status: 'open' | 'counting' | 'pending_approval' | 'closed' | 'force_closed';
  blind: boolean;
  currencies: CurrencyCode[];
  policy_snapshot: PolicySnapshot;
  opened_by: string;
  opened_by_name: string;
  opened_at: string;
  counting_started_at: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  card_total: number | null;
  card_batch_total: number | null;
  card_batch_note: string | null;
  last_seq: number;
  last_hash: string;
}

const SESSION_SELECT = `
  SELECT s.id, s.drawer_id, d.name AS drawer_name, d.tcr_code, s.location_id,
         s.business_date::text AS business_date, s.status, s.blind, s.currencies, s.policy_snapshot,
         s.opened_by, ou.full_name AS opened_by_name, s.opened_at, s.counting_started_at,
         s.closed_by, cu.full_name AS closed_by_name, s.closed_at,
         s.card_total, s.card_batch_total, s.card_batch_note, s.last_seq, s.last_hash
    FROM drawer_sessions s
    JOIN cash_drawers d ON d.id = s.drawer_id
    JOIN users ou ON ou.id = s.opened_by
    LEFT JOIN users cu ON cu.id = s.closed_by`;

function money(amount: number, currency: CurrencyCode): string {
  return formatMoney(amount, currency);
}

function thresholdsFor(snapshot: PolicySnapshot, currency: CurrencyCode): VarianceThresholds {
  return snapshot.thresholds?.[currency] ?? DEFAULT_VARIANCE_THRESHOLDS[currency];
}

function isThreshold(v: unknown): v is VarianceThresholds {
  const t = v as VarianceThresholds;
  return (
    !!t &&
    Number.isInteger(t.tolerance) &&
    Number.isInteger(t.approval) &&
    t.tolerance >= 0 &&
    t.approval >= t.tolerance
  );
}

/**
 * The cash drawer (0014).
 *
 * The shape of a shift:
 *
 *   open         a float per currency; the first opening of the day on the
 *                clinic's register is declared to CIS
 *   cash in      every cash payment the holder takes lands in her session,
 *                in the same transaction as the payment (FinanceService)
 *   drop, payout cash to the safe, or paid out with a manager's approval
 *   count        note by note, every currency; blind by default, so the
 *                expected total is withheld until the count is in
 *   close        variance within tolerance closes; above it needs a note;
 *                above the approval threshold waits for a manager
 *
 * Everything that moves cash is an event in the session's chained log
 * (drawer-ledger.ts). The expected amount is always derived from those
 * events; nothing stores a running total that could drift from them.
 */
@Injectable()
export class CashDrawerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly request: RequestContextService,
    private readonly audit: ClinicAuditService,
    private readonly entitlements: EntitlementsService,
    private readonly fiscal: FiscalService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /* ── policy ───────────────────────────────────────────────────────── */

  private async policyWithin(client: PoolClient): Promise<PolicySnapshot> {
    const { rows } = await client.query<{
      blind_count: boolean;
      max_recounts: number;
      thresholds: Record<string, unknown>;
      default_float: Record<string, unknown>;
    }>('SELECT blind_count, max_recounts, thresholds, default_float FROM drawer_policies LIMIT 1');
    const r = rows[0];
    const thresholds: PolicySnapshot['thresholds'] = {};
    const defaultFloat: PolicySnapshot['defaultFloat'] = {};
    for (const c of CURRENCIES) {
      const t = r?.thresholds?.[c];
      thresholds[c] = isThreshold(t) ? { tolerance: t.tolerance, approval: t.approval } : DEFAULT_VARIANCE_THRESHOLDS[c];
      const f = r?.default_float?.[c];
      defaultFloat[c] = Number.isInteger(f) && (f as number) >= 0 ? (f as number) : 0;
    }
    return {
      blindCount: r?.blind_count ?? true,
      maxRecounts: r?.max_recounts ?? 1,
      thresholds,
      defaultFloat,
    };
  }

  getPolicy() {
    return this.tx((client) => this.policyWithin(client));
  }

  updatePolicy(dto: UpdatePolicyDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.tx(async (client) => {
      const current = await this.policyWithin(client);
      const next: PolicySnapshot = { ...current };
      if (dto.blindCount !== undefined) next.blindCount = dto.blindCount;
      if (dto.maxRecounts !== undefined) next.maxRecounts = dto.maxRecounts;
      if (dto.thresholds) {
        next.thresholds = { ...current.thresholds };
        for (const [c, t] of Object.entries(dto.thresholds)) {
          if (!isCurrency(c)) throw new BadRequestException(`${c} is not a supported currency`);
          if (!isThreshold(t)) {
            throw new BadRequestException(
              `${c}: tolerance and approval are whole minor units, and the approval threshold cannot be below the tolerance`,
            );
          }
          next.thresholds[c] = { tolerance: t.tolerance, approval: t.approval };
        }
      }
      if (dto.defaultFloat) {
        next.defaultFloat = { ...current.defaultFloat };
        for (const [c, amount] of Object.entries(dto.defaultFloat)) {
          if (!isCurrency(c)) throw new BadRequestException(`${c} is not a supported currency`);
          if (!Number.isInteger(amount) || amount < 0) {
            throw new BadRequestException(`${c}: the default float is a whole, non-negative amount`);
          }
          next.defaultFloat[c] = amount;
        }
      }
      await client.query(
        `INSERT INTO drawer_policies (tenant_id, blind_count, max_recounts, thresholds, default_float, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id) DO UPDATE
           SET blind_count = EXCLUDED.blind_count, max_recounts = EXCLUDED.max_recounts,
               thresholds = EXCLUDED.thresholds, default_float = EXCLUDED.default_float,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tenantId, next.blindCount, next.maxRecounts, JSON.stringify(next.thresholds),
         JSON.stringify(next.defaultFloat), actor.userId],
      );
      await this.audit.record(client, actor, {
        action: 'drawer.policy_updated',
        entityType: 'drawer_policy',
        entityId: null,
        summary: `Changed the cash drawer rules${next.blindCount !== current.blindCount ? ` (blind counting ${next.blindCount ? 'on' : 'off'})` : ''}`,
        metadata: { before: current, after: next },
      });
      return next;
    });
  }

  /* ── drawers ──────────────────────────────────────────────────────── */

  private async defaultLocationId(client: PoolClient): Promise<string> {
    const found = await client.query<{ id: string }>('SELECT id FROM locations WHERE is_default LIMIT 1');
    if (found.rows[0]) return found.rows[0].id;
    // A clinic created after 0013 by a path that did not create its default
    // location: create it now, named after the clinic.
    const tenantId = this.tenant.getRequiredTenantId();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, is_default)
       SELECT t.id, t.name, true FROM tenants t WHERE t.id = $1
       RETURNING id`,
      [tenantId],
    );
    return rows[0]!.id;
  }

  listDrawers() {
    return this.tx(async (client) => {
      const { rows } = await client.query<{
        id: string;
        name: string;
        tcr_code: string | null;
        currencies: CurrencyCode[];
        is_active: boolean;
        location_id: string;
        session_id: string | null;
        session_status: string | null;
        held_by: string | null;
        held_by_name: string | null;
      }>(
        `SELECT d.id, d.name, d.tcr_code, d.currencies, d.is_active, d.location_id,
                s.id AS session_id, s.status AS session_status, s.opened_by AS held_by, u.full_name AS held_by_name
           FROM cash_drawers d
           LEFT JOIN drawer_sessions s ON s.drawer_id = d.id AND s.status IN ${UNCLOSED}
           LEFT JOIN users u ON u.id = s.opened_by
          ORDER BY d.is_active DESC, lower(d.name)`,
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        tcrCode: r.tcr_code,
        currencies: r.currencies,
        isActive: r.is_active,
        locationId: r.location_id,
        openSession: r.session_id
          ? { id: r.session_id, status: r.session_status, heldBy: { id: r.held_by, name: r.held_by_name } }
          : null,
      }));
    });
  }

  createDrawer(dto: CreateDrawerDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.tx(async (client) => {
      const currencies = [...new Set(dto.currencies)];
      const ccy = await clinicCurrency(client);
      if (!currencies.includes(ccy)) {
        throw new BadRequestException(`A drawer must hold ${ccy}, the currency this clinic takes payments in`);
      }
      let locationId = dto.locationId;
      if (locationId) {
        const loc = await client.query('SELECT 1 FROM locations WHERE id = $1 AND is_active', [locationId]);
        if (!loc.rowCount) throw new NotFoundException('Location not found');
      } else {
        locationId = await this.defaultLocationId(client);
      }
      const { rows } = await client
        .query<{ id: string }>(
          `INSERT INTO cash_drawers (tenant_id, location_id, name, tcr_code, currencies)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [tenantId, locationId, dto.name.trim(), dto.tcrCode ?? null, currencies],
        )
        .catch((err: { code?: string }) => {
          if (err.code === '23505') throw new ConflictException('There is already a drawer with that name');
          throw err;
        });
      await this.audit.record(client, actor, {
        action: 'drawer.created',
        entityType: 'cash_drawer',
        entityId: rows[0]!.id,
        summary: `Added the cash drawer ${dto.name.trim()} (${currencies.join(', ')})`,
        metadata: { name: dto.name.trim(), currencies, tcrCode: dto.tcrCode ?? null },
      });
      return { id: rows[0]!.id };
    });
  }

  updateDrawer(id: string, dto: UpdateDrawerDto, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const { rows } = await client.query<{
        name: string;
        tcr_code: string | null;
        currencies: CurrencyCode[];
        is_active: boolean;
      }>('SELECT name, tcr_code, currencies, is_active FROM cash_drawers WHERE id = $1 FOR UPDATE', [id]);
      const cur = rows[0];
      if (!cur) throw new NotFoundException('Drawer not found');

      const changesMoney = dto.currencies !== undefined || dto.isActive === false || dto.tcrCode !== undefined;
      if (changesMoney) {
        const open = await client.query(`SELECT 1 FROM drawer_sessions WHERE drawer_id = $1 AND status IN ${UNCLOSED}`, [id]);
        if (open.rowCount) {
          throw new ConflictException('Close the open session on this drawer before changing its currencies, register or status');
        }
      }
      const currencies = dto.currencies ? [...new Set(dto.currencies)] : cur.currencies;
      const ccy = await clinicCurrency(client);
      if (!currencies.includes(ccy)) {
        throw new BadRequestException(`A drawer must hold ${ccy}, the currency this clinic takes payments in`);
      }
      const next = {
        name: dto.name?.trim() ?? cur.name,
        tcrCode: dto.tcrCode === undefined ? cur.tcr_code : dto.tcrCode,
        currencies,
        isActive: dto.isActive ?? cur.is_active,
      };
      await client
        .query(
          `UPDATE cash_drawers SET name = $2, tcr_code = $3, currencies = $4, is_active = $5, updated_at = now()
            WHERE id = $1`,
          [id, next.name, next.tcrCode, next.currencies, next.isActive],
        )
        .catch((err: { code?: string }) => {
          if (err.code === '23505') throw new ConflictException('There is already a drawer with that name');
          throw err;
        });
      await this.audit.record(client, actor, {
        action: 'drawer.updated',
        entityType: 'cash_drawer',
        entityId: id,
        summary: next.isActive === cur.is_active
          ? `Changed the cash drawer ${next.name}`
          : `${next.isActive ? 'Restored' : 'Retired'} the cash drawer ${next.name}`,
        metadata: { before: cur, after: next },
      });
      return { id };
    });
  }

  /** Administrators who can approve at the desk with a PIN. */
  approvers() {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ id: string; full_name: string; role: string }>(
        `SELECT id, full_name, role FROM users
          WHERE status = 'active' AND approval_pin_hash IS NOT NULL
          ORDER BY full_name`,
      );
      return rows
        .filter((r) => {
          const role = normalizeRole(r.role);
          return role !== null && can(role, 'drawer:approve');
        })
        .map((r) => ({ id: r.id, name: r.full_name }));
    });
  }

  setApprovalPin(dto: SetApprovalPinDto, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
        [actor.userId],
      );
      if (!rows[0] || !(await bcrypt.compare(dto.currentPassword, rows[0].password_hash))) {
        throw new ForbiddenException('The current password is not correct');
      }
      const hash = await bcrypt.hash(dto.pin, BCRYPT_ROUNDS);
      await client.query(
        `UPDATE users SET approval_pin_hash = $2, approval_pin_failed_attempts = 0,
                          approval_pin_locked_until = NULL, updated_at = now()
          WHERE id = $1`,
        [actor.userId, hash],
      );
      await this.audit.record(client, actor, {
        action: 'auth.approval_pin_set',
        entityType: 'user',
        entityId: actor.userId,
        summary: 'Set a cash approval PIN',
      });
      return { set: true as const };
    });
  }

  /* ── sessions: reading ────────────────────────────────────────────── */

  private async sessionRow(client: PoolClient, id: string, lock = false): Promise<SessionRow> {
    const { rows } = await client.query<SessionRow>(
      `${SESSION_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Drawer session not found');
    return rows[0];
  }

  /** The session, only for the person who holds it. */
  private async ownSession(
    client: PoolClient,
    id: string,
    actor: ClinicAuditActor,
    statuses: SessionRow['status'][],
  ): Promise<SessionRow> {
    const s = await this.sessionRow(client, id, true);
    if (s.opened_by !== actor.userId) {
      throw new ForbiddenException('Only the person holding this drawer can do that');
    }
    if (!statuses.includes(s.status)) {
      throw new ConflictException({
        code: 'drawer_wrong_state',
        message: `This drawer is ${s.status.replace('_', ' ')}.`,
        status: s.status,
      });
    }
    return s;
  }

  private async view(client: PoolClient, s: SessionRow, viewer: ClinicAuditActor) {
    const events = await readEvents(client, s.id);
    const oversight = can(viewer.role, 'drawer:read');
    const counts = await client.query<{
      attempt_no: number;
      currency: CurrencyCode;
      total: number;
      expected: number;
      counted_by_name: string | null;
      counted_at: string;
      denominations: Record<string, number>;
    }>(
      `SELECT c.attempt_no, c.currency, c.total, c.expected, u.full_name AS counted_by_name, c.counted_at,
              c.denominations
         FROM drawer_counts c LEFT JOIN users u ON u.id = c.counted_by
        WHERE c.session_id = $1 ORDER BY c.attempt_no, c.currency`,
      [s.id],
    );
    const reviews = await client.query<{
      currency: CurrencyCode;
      expected: number;
      counted: number;
      variance: number;
      band: VarianceBand;
      note: string | null;
    }>(
      'SELECT currency, expected, counted, variance, band, note FROM drawer_session_reviews WHERE session_id = $1 ORDER BY currency',
      [s.id],
    );
    const approvals = await client.query<{
      id: string;
      action: string;
      approver_name: string | null;
      method: string;
      self_approved: boolean;
      reason: string;
      approved_at: string;
    }>(
      `SELECT a.id, a.action, u.full_name AS approver_name, a.method, a.self_approved, a.reason, a.approved_at
         FROM manager_approvals a LEFT JOIN users u ON u.id = a.approver_user_id
        WHERE a.subject_type = 'drawer_session' AND a.subject_id = $1
        ORDER BY a.approved_at`,
      [s.id],
    );

    // Blind counting: the person counting does not see what the drawer
    // should hold until her count is in. Oversight roles always see it.
    const counted = counts.rows.length > 0;
    const revealed = !s.blind || oversight || counted;
    const expected = expectedCash(events.filter((e) => e.type !== 'post_close_void'));
    const cashPayments = events.filter((e) => e.type === 'cash_sale').length;

    return {
      id: s.id,
      drawer: { id: s.drawer_id, name: s.drawer_name },
      locationId: s.location_id,
      businessDate: s.business_date,
      status: s.status,
      blind: s.blind,
      currencies: s.currencies,
      openedBy: { id: s.opened_by, name: s.opened_by_name },
      openedAt: s.opened_at,
      countingStartedAt: s.counting_started_at,
      closedBy: s.closed_by ? { id: s.closed_by, name: s.closed_by_name } : null,
      closedAt: s.closed_at,
      expected: revealed ? expected : null,
      thresholds: revealed ? Object.fromEntries(s.currencies.map((c) => [c, thresholdsFor(s.policy_snapshot, c)])) : null,
      maxRecounts: s.policy_snapshot.maxRecounts ?? 1,
      cashPayments,
      cardTotal: s.card_total,
      cardBatchTotal: s.card_batch_total,
      cardBatchNote: s.card_batch_note,
      counts: counts.rows.map((c) => ({
        attempt: c.attempt_no,
        currency: c.currency,
        total: c.total,
        expected: c.expected,
        countedBy: c.counted_by_name,
        countedAt: c.counted_at,
        denominations: c.denominations,
      })),
      reviews: reviews.rows,
      approvals: approvals.rows.map((a) => ({
        id: a.id,
        action: a.action,
        approver: a.approver_name,
        method: a.method,
        selfApproved: a.self_approved,
        reason: a.reason,
        approvedAt: a.approved_at,
      })),
      // The event log, with amounts, is for oversight and for a session that is
      // over; while a blind session is open its sums would give the count away.
      events:
        oversight || !['open', 'counting'].includes(s.status)
          ? events.map((e) => ({
              seq: e.seq,
              type: e.type,
              currency: e.currency,
              amount: e.amount,
              paymentId: e.paymentId,
              reason: e.reason,
              actor: e.actorName,
              ip: oversight ? e.ip : null,
              userAgent: oversight ? e.userAgent : null,
              occurredAt: e.occurredAt,
            }))
          : null,
      chain: oversight ? verifyChain(events, { lastSeq: s.last_seq, lastHash: s.last_hash }) : null,
    };
  }

  getSession(id: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const s = await this.sessionRow(client, id);
      if (s.opened_by !== actor.userId && !can(actor.role, 'drawer:read')) {
        throw new NotFoundException('Drawer session not found');
      }
      return this.view(client, s, actor);
    });
  }

  /** The signed-in person's unclosed session, the drawers, and what opening one needs. */
  current(actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const { rows } = await client.query<SessionRow>(
        `${SESSION_SELECT} WHERE s.opened_by = $1 AND s.status IN ${UNCLOSED}`,
        [actor.userId],
      );
      const policy = await this.policyWithin(client);
      const drawers = await client.query<{
        id: string;
        name: string;
        currencies: CurrencyCode[];
        held_by_name: string | null;
      }>(
        `SELECT d.id, d.name, d.currencies, u.full_name AS held_by_name
           FROM cash_drawers d
           LEFT JOIN drawer_sessions s ON s.drawer_id = d.id AND s.status IN ${UNCLOSED}
           LEFT JOIN users u ON u.id = s.opened_by
          WHERE d.is_active
          ORDER BY lower(d.name)`,
      );
      return {
        session: rows[0] ? await this.view(client, rows[0], actor) : null,
        drawers: drawers.rows.map((d) => ({
          id: d.id,
          name: d.name,
          currencies: d.currencies,
          heldBy: d.held_by_name,
          defaultFloat: Object.fromEntries(d.currencies.map((c) => [c, policy.defaultFloat[c] ?? 0])),
        })),
        blindCount: policy.blindCount,
      };
    });
  }

  list(q: ListSessionsQueryDto) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace('$$', `$${params.length}`));
      };
      if (q.from) add('s.business_date >= $$::date', q.from);
      if (q.to) add('s.business_date <= $$::date', q.to);
      if (q.userId) add('s.opened_by = $$', q.userId);
      if (q.drawerId) add('s.drawer_id = $$', q.drawerId);
      if (q.varianceOnly === 'true') {
        where.push(`EXISTS (SELECT 1 FROM drawer_session_reviews r WHERE r.session_id = s.id AND r.band <> 'exact')`);
      }
      const { rows } = await client.query(
        `${SESSION_SELECT.replace(
          'FROM drawer_sessions s',
          `, coalesce((SELECT jsonb_agg(jsonb_build_object('currency', r.currency, 'expected', r.expected,
                             'counted', r.counted, 'variance', r.variance, 'band', r.band, 'note', r.note)
                             ORDER BY r.currency)
                        FROM drawer_session_reviews r WHERE r.session_id = s.id), '[]'::jsonb) AS reviews,
             (SELECT count(*) FROM drawer_counts c WHERE c.session_id = s.id) AS count_rows,
             EXISTS (SELECT 1 FROM manager_approvals a WHERE a.subject_type = 'drawer_session'
                      AND a.subject_id = s.id AND a.self_approved) AS self_approved,
             EXISTS (SELECT 1 FROM drawer_events e WHERE e.session_id = s.id AND e.type = 'post_close_void')
               AS voided_after_close
           FROM drawer_sessions s`,
        )}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY s.business_date DESC, s.opened_at DESC
         LIMIT 300`,
        params,
      );
      return rows.map((r) => ({
        id: r.id,
        drawer: { id: r.drawer_id, name: r.drawer_name },
        businessDate: r.business_date,
        status: r.status,
        blind: r.blind,
        openedBy: { id: r.opened_by, name: r.opened_by_name },
        openedAt: r.opened_at,
        closedBy: r.closed_by ? { id: r.closed_by, name: r.closed_by_name } : null,
        closedAt: r.closed_at,
        cardTotal: r.card_total,
        cardBatchTotal: r.card_batch_total,
        reviews: r.reviews,
        recounted: Number(r.count_rows) > r.currencies.length,
        selfApproved: r.self_approved,
        voidedAfterClose: r.voided_after_close,
      }));
    });
  }

  /* ── sessions: opening ────────────────────────────────────────────── */

  async open(dto: OpenSessionDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    const opened = await this.tx(async (client) => {
      const d = await client.query<{
        id: string;
        name: string;
        location_id: string;
        tcr_code: string | null;
        currencies: CurrencyCode[];
        is_active: boolean;
      }>('SELECT id, name, location_id, tcr_code, currencies, is_active FROM cash_drawers WHERE id = $1 FOR UPDATE', [
        dto.drawerId,
      ]);
      const drawer = d.rows[0];
      if (!drawer) throw new NotFoundException('Drawer not found');
      if (!drawer.is_active) throw new BadRequestException('This drawer has been retired');

      const heldDrawer = await client.query<{ name: string }>(
        `SELECT u.full_name AS name FROM drawer_sessions s JOIN users u ON u.id = s.opened_by
          WHERE s.drawer_id = $1 AND s.status IN ${UNCLOSED}`,
        [drawer.id],
      );
      if (heldDrawer.rows[0]) {
        throw new ConflictException({
          code: 'drawer_in_use',
          message: `${drawer.name} is already open, held by ${heldDrawer.rows[0].name}.`,
        });
      }
      const mine = await client.query<{ name: string }>(
        `SELECT d.name FROM drawer_sessions s JOIN cash_drawers d ON d.id = s.drawer_id
          WHERE s.opened_by = $1 AND s.status IN ${UNCLOSED}`,
        [actor.userId],
      );
      if (mine.rows[0]) {
        throw new ConflictException({
          code: 'drawer_already_held',
          message: `You already hold ${mine.rows[0].name}. Close it before opening another drawer.`,
        });
      }

      const policy = await this.policyWithin(client);
      const floats = new Map<CurrencyCode, number>();
      for (const f of dto.floats ?? []) {
        if (!drawer.currencies.includes(f.currency)) {
          throw new BadRequestException(`${drawer.name} does not hold ${f.currency}`);
        }
        if (floats.has(f.currency)) throw new BadRequestException(`${f.currency} is listed twice`);
        if (f.denominations) {
          const total = countTotal(f.currency, f.denominations);
          if (total === null) throw new BadRequestException(`The ${f.currency} float count has a note or coin that does not exist`);
          if (total !== f.amount) {
            throw new BadRequestException(
              `The ${f.currency} notes and coins add up to ${money(total, f.currency)}, not ${money(f.amount, f.currency)}`,
            );
          }
        }
        floats.set(f.currency, f.amount);
      }
      for (const c of drawer.currencies) if (!floats.has(c)) floats.set(c, policy.defaultFloat[c] ?? 0);

      const tz = (await client.query<{ timezone: string }>('SELECT timezone FROM clinic_settings LIMIT 1')).rows[0]
        ?.timezone ?? 'Europe/Tirane';
      const { rows } = await client
        .query<{ id: string }>(
          `INSERT INTO drawer_sessions
             (tenant_id, drawer_id, location_id, business_date, blind, currencies, policy_snapshot, opened_by)
           VALUES ($1,$2,$3,(now() AT TIME ZONE $4)::date,$5,$6,$7,$8)
           RETURNING id`,
          [tenantId, drawer.id, drawer.location_id, tz, policy.blindCount, drawer.currencies,
           JSON.stringify(policy), actor.userId],
        )
        .catch((err: { code?: string }) => {
          // Someone opened it in the moment between the check and the insert.
          if (err.code === '23505') {
            throw new ConflictException({ code: 'drawer_in_use', message: `${drawer.name} was just opened by someone else.` });
          }
          throw err;
        });
      const sessionId = rows[0]!.id;
      const request = this.request.get();
      for (const c of drawer.currencies) {
        await appendEvent(client, tenantId, sessionId, {
          type: 'open', currency: c, amount: floats.get(c)!, actorUserId: actor.userId,
        }, request);
      }
      const floatText = drawer.currencies.map((c) => money(floats.get(c)!, c)).join(' and ');
      await this.audit.record(client, actor, {
        action: 'drawer.opened',
        entityType: 'drawer_session',
        entityId: sessionId,
        summary: `Opened ${drawer.name} with ${floatText}`,
        metadata: { drawerId: drawer.id, floats: Object.fromEntries(floats) },
      });
      return { sessionId, drawer, floats };
    });

    const allFloat = opened.floats.get('ALL');
    const fiscalDeclaration =
      allFloat === undefined
        ? { status: 'not_required' as const, message: null }
        : await this.fiscal.declareForDrawer({
            operation: 'INITIAL',
            amount: allFloat,
            currency: 'ALL',
            drawerTcrCode: opened.drawer.tcr_code,
            drawerSessionId: opened.sessionId,
            actor,
          });
    const session = await this.getSession(opened.sessionId, actor);
    return { ...session, fiscalDeclaration };
  }

  /* ── cash payments (called from FinanceService, inside its transaction) ── */

  /**
   * The session a cash payment by `actor` goes into, or null when the clinic
   * does not use the cash drawer. Refuses — and so refuses the payment — when
   * the drawer is on and this person holds no open drawer.
   */
  async sessionForCashPayment(client: PoolClient, actor: ClinicAuditActor): Promise<string | null> {
    if (!(await this.entitlements.isEnabled(client, 'cash_drawer'))) return null;
    const { rows } = await client.query<{ id: string; status: string; currencies: CurrencyCode[] }>(
      `SELECT id, status, currencies FROM drawer_sessions
        WHERE opened_by = $1 AND status IN ${UNCLOSED}
        FOR UPDATE`,
      [actor.userId],
    );
    const s = rows[0];
    if (!s) {
      throw new ConflictException({
        code: 'drawer_not_open',
        message: 'Open your cash drawer before taking a cash payment.',
      });
    }
    if (s.status !== 'open') {
      throw new ConflictException({
        code: 'drawer_counting',
        message: 'Your drawer is being closed. Go back to the open drawer, or finish closing it and open a new one, before taking cash.',
      });
    }
    const ccy = await clinicCurrency(client);
    if (!s.currencies.includes(ccy)) {
      throw new ConflictException({
        code: 'drawer_currency',
        message: `Your drawer does not hold ${ccy}.`,
      });
    }
    return s.id;
  }

  async recordCashSale(client: PoolClient, actor: ClinicAuditActor, sessionId: string, paymentId: string, amount: number) {
    const tenantId = this.tenant.getRequiredTenantId();
    await appendEvent(client, tenantId, sessionId, {
      type: 'cash_sale', currency: await clinicCurrency(client), amount, paymentId, actorUserId: actor.userId,
    }, this.request.get());
  }

  /**
   * A cash payment was voided. While its session is open, the cash is taken
   * back off what the drawer should hold. After it closed, the void is noted
   * against that session and changes nothing already reviewed. While it is
   * being counted, the void waits: changing the expected amount under
   * somebody's count would make her count wrong.
   */
  async recordCashVoid(client: PoolClient, actor: ClinicAuditActor, paymentId: string, amount: number, reason: string) {
    const { rows } = await client.query<{ session_id: string; status: string }>(
      `SELECT s.id AS session_id, s.status
         FROM payments p JOIN drawer_sessions s ON s.id = p.drawer_session_id
        WHERE p.id = $1
        FOR UPDATE OF s`,
      [paymentId],
    );
    const s = rows[0];
    if (!s) return;
    if (s.status === 'counting' || s.status === 'pending_approval') {
      throw new ConflictException({
        code: 'drawer_counting',
        message: 'This payment is in a drawer that is being closed. Void it once the drawer is closed.',
      });
    }
    const tenantId = this.tenant.getRequiredTenantId();
    await appendEvent(client, tenantId, s.session_id, {
      type: s.status === 'open' ? 'cash_sale_voided' : 'post_close_void',
      currency: await clinicCurrency(client),
      amount,
      paymentId,
      reason,
      actorUserId: actor.userId,
    }, this.request.get());
  }

  /* ── cash movements ───────────────────────────────────────────────── */

  async drop(sessionId: string, dto: DropDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    const done = await this.tx(async (client) => {
      const s = await this.ownSession(client, sessionId, actor, ['open']);
      if (!s.currencies.includes(dto.currency)) throw new BadRequestException(`This drawer does not hold ${dto.currency}`);
      const expected = expectedCash(await readEvents(client, s.id))[dto.currency] ?? 0;
      if (dto.amount > expected) {
        throw new BadRequestException('That is more cash than this drawer should hold.');
      }
      await appendEvent(client, tenantId, s.id, {
        type: 'drop', currency: dto.currency, amount: dto.amount, reason: dto.reason ?? null, actorUserId: actor.userId,
      }, this.request.get());
      await this.audit.record(client, actor, {
        action: 'drawer.cash_dropped',
        entityType: 'drawer_session',
        entityId: s.id,
        summary: `Moved ${money(dto.amount, dto.currency)} from ${s.drawer_name} to the safe`,
        metadata: { currency: dto.currency, amount: dto.amount },
      });
      return s;
    });
    const fiscalDeclaration =
      dto.currency === 'ALL'
        ? await this.fiscal.declareForDrawer({
            operation: 'WITHDRAW', amount: dto.amount, currency: 'ALL',
            drawerTcrCode: done.tcr_code, drawerSessionId: done.id, actor,
          })
        : { status: 'not_required' as const, message: null };
    return { ...(await this.getSession(sessionId, actor)), fiscalDeclaration };
  }

  noSale(sessionId: string, reason: string, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.tx(async (client) => {
      const s = await this.ownSession(client, sessionId, actor, ['open', 'counting']);
      const ccy = s.currencies[0]!;
      await appendEvent(client, tenantId, s.id, {
        type: 'no_sale', currency: ccy, amount: 0, reason, actorUserId: actor.userId,
      }, this.request.get());
      await this.audit.record(client, actor, {
        action: 'drawer.no_sale',
        entityType: 'drawer_session',
        entityId: s.id,
        summary: `Opened ${s.drawer_name} without a sale: ${reason.trim()}`,
      });
      return this.view(client, await this.sessionRow(client, s.id), actor);
    });
  }

  /**
   * A payout, or cash added from the safe. Both need someone else's approval:
   * a manager's PIN given at this desk, or — when the person holding the drawer
   * is herself an approver — her own, only if she is the clinic's sole
   * administrator.
   */
  async approvedMovement(kind: 'payout' | 'add_float', sessionId: string, dto: ApprovedMovementDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    const pinApprover = dto.approval
      ? await this.verifyPin(tenantId, dto.approval.approverUserId, dto.approval.pin)
      : null;

    return this.tx(async (client) => {
      const s = await this.ownSession(client, sessionId, actor, ['open']);
      if (!s.currencies.includes(dto.currency)) throw new BadRequestException(`This drawer does not hold ${dto.currency}`);

      let approverId: string;
      let method: 'pin' | 'session';
      if (pinApprover) {
        approverId = pinApprover;
        method = 'pin';
      } else if (can(actor.role, 'drawer:approve')) {
        approverId = actor.userId;
        method = 'session';
      } else {
        throw new ForbiddenException({
          code: 'approval_required',
          message: `A manager must approve ${kind === 'payout' ? 'a payout' : 'adding cash'}.`,
        });
      }
      const selfApproved = approverId === actor.userId;
      if (selfApproved && !(await this.soleAdministrator(client, actor.userId))) {
        throw new ForbiddenException({
          code: 'approval_required',
          message: 'Another administrator must approve cash moving through your own drawer.',
        });
      }

      if (kind === 'payout') {
        const expected = expectedCash(await readEvents(client, s.id))[dto.currency] ?? 0;
        if (dto.amount > expected) throw new BadRequestException('That is more cash than this drawer should hold.');
      }

      const approvalId = await this.insertApproval(client, {
        action: kind === 'payout' ? 'drawer_payout' : 'drawer_add_float',
        sessionId: s.id,
        approverId,
        requestedBy: actor.userId,
        method,
        reason: dto.reason,
        selfApproved,
      });
      await appendEvent(client, tenantId, s.id, {
        type: kind, currency: dto.currency, amount: dto.amount, reason: dto.reason, approvalId, actorUserId: actor.userId,
      }, this.request.get());
      await this.audit.record(client, actor, {
        action: kind === 'payout' ? 'drawer.payout' : 'drawer.float_added',
        entityType: 'drawer_session',
        entityId: s.id,
        summary: `${kind === 'payout' ? 'Paid out' : 'Added'} ${money(dto.amount, dto.currency)} ${kind === 'payout' ? 'from' : 'to'} ${s.drawer_name}: ${dto.reason.trim()}`,
        metadata: { currency: dto.currency, amount: dto.amount, approvalId, selfApproved },
      });
      return this.view(client, await this.sessionRow(client, s.id), actor);
    });
  }

  /* ── closing ──────────────────────────────────────────────────────── */

  private async checklist(client: PoolClient, s: SessionRow) {
    const invoices = await client.query<{ id: string; invoice_number: string; patient_name: string; balance: string }>(
      `SELECT i.id, i.invoice_number, (p.first_name || ' ' || p.last_name) AS patient_name,
              i.total - coalesce((SELECT sum(amount) FROM payments pay
                                   WHERE pay.invoice_id = i.id AND pay.voided_at IS NULL), 0) AS balance
         FROM invoices i JOIN patients p ON p.id = i.patient_id
        WHERE i.created_by = $1 AND i.created_at >= $2 AND i.status IN ('unpaid','partially_paid')
        ORDER BY i.created_at`,
      [s.opened_by, s.opened_at],
    );
    const other = await client.query<{ method: string; n: string; total: string }>(
      `SELECT method, count(*) AS n, coalesce(sum(amount), 0) AS total FROM payments
        WHERE created_by = $1 AND paid_at >= $2 AND voided_at IS NULL AND method IN ('card','bank')
        GROUP BY method`,
      [s.opened_by, s.opened_at],
    );
    const by = (m: string) => other.rows.find((r) => r.method === m);
    return {
      openInvoices: invoices.rows.map((r) => ({
        id: r.id, invoiceNumber: r.invoice_number, patientName: r.patient_name, balance: Number(r.balance),
      })),
      card: { count: Number(by('card')?.n ?? 0), total: Number(by('card')?.total ?? 0) },
      bank: { count: Number(by('bank')?.n ?? 0), total: Number(by('bank')?.total ?? 0) },
    };
  }

  startCount(sessionId: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const s = await this.ownSession(client, sessionId, actor, ['open', 'counting']);
      if (s.status === 'open') {
        await client.query(
          `UPDATE drawer_sessions SET status = 'counting', counting_started_at = now() WHERE id = $1`,
          [s.id],
        );
      }
      const fresh = await this.sessionRow(client, s.id);
      return { session: await this.view(client, fresh, actor), checklist: await this.checklist(client, fresh) };
    });
  }

  /** Back to taking cash, before anything was counted. */
  resumeOpen(sessionId: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const s = await this.ownSession(client, sessionId, actor, ['counting']);
      await client
        .query(`UPDATE drawer_sessions SET status = 'open' WHERE id = $1`, [s.id])
        .catch((err: { code?: string }) => {
          if (err.code === '23514') {
            throw new ConflictException({
              code: 'drawer_counted',
              message: 'This drawer has already been counted. Close it and open a new session to take more cash.',
            });
          }
          throw err;
        });
      return this.view(client, await this.sessionRow(client, s.id), actor);
    });
  }

  submitCount(sessionId: string, dto: SubmitCountDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.tx(async (client) => {
      const s = await this.ownSession(client, sessionId, actor, ['counting']);
      const result = await this.recordCounts(client, tenantId, s, dto.counts, actor, { limitRecounts: true });
      await this.audit.record(client, actor, {
        action: 'drawer.counted',
        entityType: 'drawer_session',
        entityId: s.id,
        summary: `Counted ${s.drawer_name}${result.attempt > 1 ? ` again (count ${result.attempt})` : ''}: ${result.lines
          .map((l) => `${money(l.counted, l.currency)} counted, ${l.variance === 0 ? 'no difference' : `${l.variance > 0 ? 'over' : 'short'} ${money(Math.abs(l.variance), l.currency)}`}`)
          .join('; ')}`,
        metadata: { attempt: result.attempt, lines: result.lines },
      });
      return result;
    });
  }

  private async recordCounts(
    client: PoolClient,
    tenantId: string,
    s: SessionRow,
    counts: SubmitCountDto['counts'],
    counter: ClinicAuditActor,
    opts: { limitRecounts: boolean },
  ) {
    const submitted = new Map<CurrencyCode, Record<string, number>>();
    for (const c of counts) {
      if (submitted.has(c.currency)) throw new BadRequestException(`${c.currency} is counted twice`);
      if (!s.currencies.includes(c.currency)) throw new BadRequestException(`This drawer does not hold ${c.currency}`);
      submitted.set(c.currency, c.denominations);
    }
    const missing = s.currencies.filter((c) => !submitted.has(c));
    if (missing.length) {
      throw new BadRequestException(`Count every currency in the drawer, including an empty one: ${missing.join(', ')} is missing`);
    }

    const prior = await client.query<{ n: number | null }>(
      'SELECT max(attempt_no) AS n FROM drawer_counts WHERE session_id = $1',
      [s.id],
    );
    const attempt = (prior.rows[0]?.n ?? 0) + 1;
    const allowed = 1 + (s.policy_snapshot.maxRecounts ?? 1);
    if (opts.limitRecounts && attempt > allowed) {
      throw new ConflictException({ code: 'no_recounts_left', message: 'This drawer has been counted as many times as the clinic allows.' });
    }

    const expected = expectedCash((await readEvents(client, s.id)).filter((e) => e.type !== 'post_close_void'));
    const lines: { currency: CurrencyCode; counted: number; expected: number; variance: number; band: VarianceBand }[] = [];
    for (const c of s.currencies) {
      const denominations = submitted.get(c)!;
      const total = countTotal(c, denominations);
      if (total === null) {
        throw new BadRequestException(`The ${c} count has a note or coin that does not exist, or a quantity that is not a whole number`);
      }
      const exp = expected[c] ?? 0;
      await client.query(
        `INSERT INTO drawer_counts (tenant_id, session_id, attempt_no, currency, denominations, total, expected, counted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, s.id, attempt, c, JSON.stringify(denominations), total, exp, counter.userId],
      );
      const variance = total - exp;
      lines.push({ currency: c, counted: total, expected: exp, variance, band: varianceBand(variance, thresholdsFor(s.policy_snapshot, c)) });
    }
    return { attempt, recountsLeft: Math.max(0, allowed - attempt), lines };
  }

  close(sessionId: string, dto: CloseSessionDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.tx(async (client) => {
      const s = await this.ownSession(client, sessionId, actor, ['counting']);
      const latest = await client.query<{ currency: CurrencyCode; total: number; expected: number }>(
        `SELECT DISTINCT ON (currency) currency, total, expected FROM drawer_counts
          WHERE session_id = $1 ORDER BY currency, attempt_no DESC`,
        [s.id],
      );
      const byCurrency = new Map(latest.rows.map((r) => [r.currency, r]));
      if (s.currencies.some((c) => !byCurrency.has(c))) {
        throw new ConflictException({ code: 'not_counted', message: 'Count the drawer before closing it.' });
      }

      const checklist = await this.checklist(client, s);
      if (checklist.openInvoices.length && !dto.acknowledgeOpenInvoices) {
        throw new ConflictException({
          code: 'open_invoices',
          message: `${checklist.openInvoices.length} unpaid invoice${checklist.openInvoices.length === 1 ? '' : 's'} from this shift. Take payment, or confirm they stay on the patients' accounts.`,
          openInvoices: checklist.openInvoices,
        });
      }

      const reviews = s.currencies.map((c) => {
        const count = byCurrency.get(c)!;
        const variance = count.total - count.expected;
        const band = varianceBand(variance, thresholdsFor(s.policy_snapshot, c));
        const note = dto.notes?.[c]?.trim() || null;
        if (band !== 'exact' && (note?.length ?? 0) < VARIANCE_NOTE_MIN_LENGTH) {
          throw new BadRequestException({
            code: 'variance_note_required',
            currency: c,
            message: `Explain the ${c} difference of ${money(Math.abs(variance), c)} in at least ${VARIANCE_NOTE_MIN_LENGTH} characters.`,
          });
        }
        return { currency: c, expected: count.expected, counted: count.total, variance, band, note };
      });

      for (const r of reviews) {
        await client.query(
          `INSERT INTO drawer_session_reviews (tenant_id, session_id, currency, expected, counted, variance, band, note, reviewed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tenantId, s.id, r.currency, r.expected, r.counted, r.variance, r.band, r.note, actor.userId],
        );
      }
      const needsApproval = reviews.some((r) => r.band === 'approval');
      await client.query(
        `UPDATE drawer_sessions
            SET status = $2, closed_by = $3, closed_at = $4,
                card_total = $5, card_batch_total = $6, card_batch_note = $7
          WHERE id = $1`,
        [
          s.id,
          needsApproval ? 'pending_approval' : 'closed',
          needsApproval ? null : actor.userId,
          needsApproval ? null : new Date().toISOString(),
          checklist.card.total,
          dto.cardBatchTotal ?? null,
          dto.cardBatchNote?.trim() || null,
        ],
      );
      await this.audit.record(client, actor, {
        action: needsApproval ? 'drawer.approval_requested' : 'drawer.closed',
        entityType: 'drawer_session',
        entityId: s.id,
        summary: `${needsApproval ? 'Closed pending approval' : 'Closed'} ${s.drawer_name}: ${reviews
          .map((r) => (r.variance === 0 ? `${r.currency} balanced` : `${r.currency} ${r.variance > 0 ? 'over' : 'short'} ${money(Math.abs(r.variance), r.currency)}`))
          .join(', ')}`,
        metadata: {
          reviews,
          openInvoicesLeft: checklist.openInvoices.map((i) => i.invoiceNumber),
          cardTotal: checklist.card.total,
          cardBatchTotal: dto.cardBatchTotal ?? null,
        },
      });
      return this.view(client, await this.sessionRow(client, s.id), actor);
    });
  }

  /* ── approvals ────────────────────────────────────────────────────── */

  private async soleAdministrator(client: PoolClient, userId: string): Promise<boolean> {
    const { rows } = await client.query<{ role: string; others: string }>(
      `SELECT u.role,
              (SELECT count(*) FROM users o WHERE o.role = 'admin' AND o.status = 'active' AND o.id <> u.id) AS others
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    return rows[0]?.role === 'admin' && Number(rows[0].others) === 0;
  }

  private async insertApproval(
    client: PoolClient,
    a: {
      action: 'drawer_variance' | 'drawer_payout' | 'drawer_force_close' | 'drawer_add_float';
      sessionId: string;
      approverId: string;
      requestedBy: string | null;
      method: 'pin' | 'session';
      reason: string;
      selfApproved: boolean;
    },
  ): Promise<string> {
    const req = this.request.get();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO manager_approvals
         (tenant_id, action, subject_type, subject_id, approver_user_id, requested_by, method, reason,
          self_approved, request_id, ip, user_agent)
       VALUES ($1,$2,'drawer_session',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [this.tenant.getRequiredTenantId(), a.action, a.sessionId, a.approverId, a.requestedBy, a.method,
       a.reason.trim(), a.selfApproved, req?.requestId ?? null, req?.ip ?? null, req?.userAgent ?? null],
    );
    return rows[0]!.id;
  }

  /**
   * Check a manager's PIN in its own transaction, so a wrong attempt is
   * counted even though the request that carried it then fails.
   */
  private async verifyPin(tenantId: string, approverUserId: string, pin: string): Promise<string> {
    const outcome = await this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{
        role: string;
        status: string;
        approval_pin_hash: string | null;
        approval_pin_failed_attempts: number;
        approval_pin_locked_until: Date | null;
      }>(
        `SELECT role, status, approval_pin_hash, approval_pin_failed_attempts, approval_pin_locked_until
           FROM users WHERE id = $1 FOR UPDATE`,
        [approverUserId],
      );
      const u = rows[0];
      const role = normalizeRole(u?.role);
      if (!u || u.status !== 'active' || !role || !can(role, 'drawer:approve')) return { ok: false as const, why: 'not_approver' as const };
      if (!u.approval_pin_hash) return { ok: false as const, why: 'no_pin' as const };
      if (u.approval_pin_locked_until && new Date(u.approval_pin_locked_until) > new Date()) {
        return { ok: false as const, why: 'locked' as const, until: new Date(u.approval_pin_locked_until) };
      }
      if (!(await bcrypt.compare(pin, u.approval_pin_hash))) {
        const attempts = u.approval_pin_failed_attempts + 1;
        const lock = attempts >= PIN_MAX_ATTEMPTS;
        await client.query(
          `UPDATE users SET approval_pin_failed_attempts = $2,
                            approval_pin_locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE NULL END
            WHERE id = $1`,
          [approverUserId, lock ? 0 : attempts, lock, PIN_LOCK_MINUTES],
        );
        return { ok: false as const, why: lock ? ('locked' as const) : ('wrong' as const), until: lock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000) : undefined };
      }
      if (u.approval_pin_failed_attempts > 0) {
        await client.query('UPDATE users SET approval_pin_failed_attempts = 0 WHERE id = $1', [approverUserId]);
      }
      return { ok: true as const };
    });

    if (outcome.ok) return approverUserId;
    const messages = {
      not_approver: 'That person cannot approve cash.',
      no_pin: 'That manager has not set an approval PIN yet.',
      wrong: 'The PIN is not correct.',
      locked: `Too many wrong PINs. Try again after ${outcome.until?.toISOString().slice(11, 16) ?? 'a few minutes'} UTC.`,
    };
    throw new ForbiddenException({ code: `approval_${outcome.why}`, message: messages[outcome.why] });
  }

  approve(sessionId: string, reason: string, actor: ClinicAuditActor) {
    return this.approveAs(sessionId, reason, actor.userId, 'session', actor);
  }

  async approveWithPin(sessionId: string, dto: { approverUserId: string; pin: string; reason: string }, actor: ClinicAuditActor) {
    const approverId = await this.verifyPin(this.tenant.getRequiredTenantId(), dto.approverUserId, dto.pin);
    return this.approveAs(sessionId, dto.reason, approverId, 'pin', actor);
  }

  private approveAs(sessionId: string, reason: string, approverId: string, method: 'pin' | 'session', actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const s = await this.sessionRow(client, sessionId, true);
      if (s.status !== 'pending_approval') {
        throw new ConflictException({ code: 'drawer_wrong_state', message: 'This drawer is not waiting for approval.' });
      }
      const selfApproved = approverId === s.opened_by;
      if (selfApproved && !(await this.soleAdministrator(client, approverId))) {
        throw new ForbiddenException({
          code: 'approval_required',
          message: 'Another administrator must approve a variance on your own drawer.',
        });
      }
      const approvalId = await this.insertApproval(client, {
        action: 'drawer_variance', sessionId: s.id, approverId, requestedBy: s.opened_by, method, reason, selfApproved,
      });
      await client.query(
        `UPDATE drawer_sessions SET status = 'closed', closed_by = opened_by, closed_at = now() WHERE id = $1`,
        [s.id],
      );
      await this.audit.record(client, actor, {
        action: 'drawer.variance_approved',
        entityType: 'drawer_session',
        entityId: s.id,
        summary: `Approved the variance on ${s.drawer_name} (${s.opened_by_name}, ${s.business_date})${selfApproved ? ', as the sole administrator' : ''}: ${reason.trim()}`,
        metadata: { approvalId, approverId, method, selfApproved },
      });
      return this.view(client, await this.sessionRow(client, s.id), actor);
    });
  }

  /** A manager counts and closes a session its holder left open. */
  forceClose(sessionId: string, dto: ForceCloseDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.tx(async (client) => {
      const s = await this.sessionRow(client, sessionId, true);
      if (!['open', 'counting', 'pending_approval'].includes(s.status)) {
        throw new ConflictException({ code: 'drawer_wrong_state', message: 'This drawer is already closed.' });
      }
      const selfApproved = s.opened_by === actor.userId;
      if (selfApproved && !(await this.soleAdministrator(client, actor.userId))) {
        throw new ForbiddenException({ code: 'approval_required', message: 'Another administrator must force-close your own drawer.' });
      }
      const counted = await this.recordCounts(client, tenantId, s, dto.counts, actor, { limitRecounts: false });
      for (const l of counted.lines) {
        await client.query(
          `INSERT INTO drawer_session_reviews (tenant_id, session_id, currency, expected, counted, variance, band, note, reviewed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (session_id, currency) DO NOTHING`,
          [tenantId, s.id, l.currency, l.expected, l.counted, l.variance, l.band, dto.reason.trim(), actor.userId],
        );
      }
      const approvalId = await this.insertApproval(client, {
        action: 'drawer_force_close', sessionId: s.id, approverId: actor.userId, requestedBy: s.opened_by,
        method: 'session', reason: dto.reason, selfApproved,
      });
      await client.query(
        `UPDATE drawer_sessions SET status = 'force_closed', closed_by = $2, closed_at = now() WHERE id = $1`,
        [s.id, actor.userId],
      );
      await this.audit.record(client, actor, {
        action: 'drawer.force_closed',
        entityType: 'drawer_session',
        entityId: s.id,
        summary: `Force-closed ${s.drawer_name}, left open by ${s.opened_by_name}: ${dto.reason.trim()}`,
        metadata: { approvalId, lines: counted.lines },
      });
      return this.view(client, await this.sessionRow(client, s.id), actor);
    });
  }
}
